import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {webcrypto} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import worker from '#target/src/index.ts';
import {sha} from '#target/src/util.ts';

const migration=filename=>join(process.env.CENTRAL_TEST_TARGET_ROOT,'migrations',filename);
if (!globalThis.crypto) globalThis.crypto=webcrypto;
const origin='https://mcp.example';
const resource=origin;
const clientId='mcp_'+'a'.repeat(43);
const verifier='v'.repeat(48);
const post=(path,form)=>worker.fetch(new Request(origin+path,{
  method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form.toString()
}),environment);
let environment;

function fixture(){
  const sql=new DatabaseSync(':memory:');
  sql.exec(readFileSync(migration('0001_init.sql'),'utf8'));
  sql.exec(readFileSync(migration('0002_refresh_token_rotation.sql'),'utf8'));
  sql.exec(readFileSync(migration('0003_resource_tool_policy.sql'),'utf8'));
  sql.exec(readFileSync(migration('0003_runner_registry_leases.sql'),'utf8'));
  const db={prepare(query){return {bind(...params){return {
    first:async()=>sql.prepare(query).get(...params)||null,
    all:async()=>({results:sql.prepare(query).all(...params)}),
    run:async()=>sql.prepare(query).run(...params)
  };}};}};
  environment={MCP_DB:db,MCP_PUBLIC_URL:resource,MCP_OAUTH_TTL:'900'};
  return sql;
}
async function seed(sql,{refresh=true}={}){
  sql.prepare('INSERT INTO oauth_clients(client_id,client_name,redirect_uris,grant_types,approved,allowed_owners,allowed_resources,allowed_tools,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(clientId,'Test OAuth Client','["http://127.0.0.1:1234/cb"]',JSON.stringify(refresh?['authorization_code','refresh_token']:['authorization_code']),1,'["acme"]','["default"]','[]',Math.floor(Date.now()/1000));
  const code='q'.repeat(43);
  sql.prepare('INSERT INTO oauth_codes(code_hash,client_id,redirect_uri,resource,scope,code_challenge,expires_at,auth_version) VALUES(?,?,?,?,?,?,?,0)')
    .run(await sha(code),clientId,'http://127.0.0.1:1234/cb',resource,'mcp:read',await sha(verifier),Math.floor(Date.now()/1000)+90);
  const resp=await post('/oauth/token',new URLSearchParams({grant_type:'authorization_code',code,client_id:clientId,redirect_uri:'http://127.0.0.1:1234/cb',resource,code_verifier:verifier}));
  assert.equal(resp.status,200,await resp.clone().text());
  return resp.json();
}
const rotate=(token,extra={})=>post('/oauth/token',new URLSearchParams({grant_type:'refresh_token',refresh_token:token,client_id:clientId,...extra}));
const checkAccess=(token)=>worker.fetch(new Request(resource,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})}),environment);

test('OAuth issues encrypted-at-rest-equivalent hashed refresh tokens, rotates, and detects replay by revoking family',async()=>{
  const sql=fixture();
  try{
    const first=await seed(sql);
    assert.equal(first.expires_in,900);
    assert.match(first.refresh_token,/^mcrt_[A-Za-z0-9_-]{43}$/);
    assert.ok(first.refresh_token_expires_in>29*86400);
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM oauth_refresh_tokens WHERE token_hash=?').get(await sha(first.refresh_token)).n,1);
    assert.equal((await checkAccess(first.access_token)).status,200);
    const fresh=await rotate(first.refresh_token);
    assert.equal(fresh.status,200,await fresh.clone().text());
    const next=await fresh.json();
    assert.notEqual(next.refresh_token,first.refresh_token);
    assert.notEqual(next.access_token,first.access_token);
    assert.equal((await checkAccess(next.access_token)).status,200);
    const replay=await rotate(first.refresh_token);
    assert.equal(replay.status,400);
    assert.equal((await replay.json()).error,'invalid_grant');
    assert.equal((await checkAccess(next.access_token)).status,401,'Replay must revoke newly issued access token immediately');
    assert.equal((await rotate(next.refresh_token)).status,400,'No refresh after family revocation');
  }finally{sql.close();}
});

test('refresh cannot cross client / resource or renew past 90-day absolute cap',async()=>{
  const sql=fixture();
  try{
    const first=await seed(sql);
    assert.equal((await rotate(first.refresh_token,{resource:'https://elsewhere.example/mcp'})).status,400);
    assert.equal((await rotate(first.refresh_token,{client_id:'mcp_'+'b'.repeat(43)})).status,400);
    // Invalid requests do not consume a valid refresh credential.
    assert.equal((await checkAccess(first.access_token)).status,200);
    const rotated=await rotate(first.refresh_token);
    assert.equal(rotated.status,200);
    const next=await rotated.json();
    sql.prepare('UPDATE oauth_grants SET absolute_expires_at=?').run(Math.floor(Date.now()/1000)-1);
    assert.equal((await rotate(next.refresh_token)).status,400);
    assert.equal((await checkAccess(next.access_token)).status,401);
  }finally{sql.close();}
});

test('legacy clients without refresh grant get short-lived access token only',async()=>{
  const sql=fixture();
  try{
    const token=await seed(sql,{refresh:false});
    assert.equal('refresh_token' in token,false);
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM oauth_grants').get().n,0);
  }finally{sql.close();}
});

test('two concurrent refreshes: at most one wins, second invalidates grant as suspected replay',async()=>{
  const sql=fixture();
  try{
    const token=await seed(sql);
    const [a,b]=await Promise.all([rotate(token.refresh_token),rotate(token.refresh_token)]);
    assert.ok([a.status,b.status].every(status=>status===200||status===400));
    assert.ok([a.status,b.status].filter(status=>status===200).length<=1);
    // One response may have been minted but then suppressed when replay revoked the grant.
    for(const response of [a,b])if(response.status===200){
      const minted=await response.json();
      assert.equal((await checkAccess(minted.access_token)).status,401);
    }
    assert.notEqual(sql.prepare('SELECT revoked_at FROM oauth_grants').get().revoked_at,null);
  }finally{sql.close();}
});

test('revoked client stays revoked even if admin reapproves; previous tokens never resurrect',async()=>{
  const sql=fixture();
  try{
    const token=await seed(sql);
    sql.prepare('UPDATE oauth_clients SET approved=0,auth_version=auth_version+1 WHERE client_id=?').run(clientId);
    assert.equal((await checkAccess(token.access_token)).status,401);
    sql.prepare('UPDATE oauth_clients SET approved=1,auth_version=auth_version+1 WHERE client_id=?').run(clientId);
    assert.equal((await checkAccess(token.access_token)).status,401);
    assert.equal((await rotate(token.refresh_token)).status,400);
  }finally{sql.close();}
});
