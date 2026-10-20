# 鎻愭 ORG-006锛氬姞鍥?main 鍒嗘敮鐨?ruleset

鐘舵€侊細**宸查噰绾崇涓€闃舵**锛堝洓涓叕寮€浠撳簱鍚敤涓ユ牸鐨勭姸鎬佹鏌ワ紱PR "require pull requests to be up to date before merging"锛夈€傜浜岄樁娈碉紙涓€浜哄鎵逛笌缁曡繃涓讳綋锛夊拰绗笁闃舵锛圙itHub App锛夊皻鏈惎鍔紝闇€瑕?owner 鍐冲畾銆?

## 鐜扮姸

`policies/rulesets.json` 涓烘瘡涓彈绠′粨搴撳畾涔変簡 "Protect Main Branch"锛氱姝㈠垹闄ゃ€佺姝㈤潪蹇繘鏇存柊銆佺嚎鎬у巻鍙层€佷粎鍏佽 squash 鍚堝苟銆佸鏌ョ嚎绋嬪繀椤昏В鍐筹紝骞惰姹傜姸鎬佹鏌?`validate-merge`銆備笌鏈彁妗堢浉鍏崇殑鍏蜂綋鍐呭锛?

- `required_approving_review_count: 0`銆乣require_code_owner_review: false`銆乣require_last_push_approval: false`銆乣dismiss_stale_reviews_on_push: false`銆?
- `strict_required_status_checks_policy: true`锛堢涓€闃舵宸查噰绾筹細鍚堝苟鍓嶅垎鏀繀椤讳笌 `main` 淇濇寔鏈€鏂帮級銆?
- 蹇呴渶妫€鏌ユ寜鍚嶇О鍖归厤锛坄context: "validate-merge"`锛夛紝娌℃湁 `integration_id`锛屽洜姝や换浣曡兘澶熷垱寤鸿鍚嶇О鎻愪氦鐘舵€佺殑涓讳綋閮借兘婊¤冻瀹冦€?
- `bypass_actors: []`銆?
- 鍙鏈粨搴撶殑 `policies/rulesets.json` 鍙樻洿杩涘叆 `main`锛宍apply-repository-settings.yml` 灏变細鎶婅鏂囦欢搴旂敤鍒版墍鏈夊彈绠′粨搴撱€傚洜姝や竴娆″悎骞跺氨浼氭敼鍙樻瘡涓彈绠′粨搴撱€?
- `scripts/apply-repository-settings.ts` 鍦?褰撳墠 GitHub Free 缁勭粐"涓嬩細璺宠繃绉佹湁浠撳簱鐨?rulesets銆?026-10-07 瀵?API 鐨勬鏌ユ樉绀猴細瀵逛簬 `internal-vault`銆乣delta-suite` 涓?`app-source`锛宺ulesets 涓庡垎鏀繚鎶ゆ帴鍙ｉ兘杩斿洖 403 "Upgrade to GitHub Pro or make this repository public"銆?*owner 鍐冲畾锛?026-10-07锛夛細缁勭粐淇濇寔鍦?Free 濂楅锛岀鏈変粨搴撲繚鎸佺鏈夈€?* 鍥犳杩欎笁涓粨搴撴案杩滀笉鑳芥嫢鏈夊垎鏀?ruleset锛屾湰鎻愭鍙€傜敤浜庡洓涓叕寮€浠撳簱锛坄action-worker`銆乣ai-gateway`銆乣delta`銆乣external-vault`锛夈€?
- 缁勭粐鏈変袱鍚嶆垚鍛橈紙`fongap`銆乣fongxen`锛夈€?

## 閫夐」锛堝悇鑷嫭绔嬶級

1. **瑕佹眰 1 浜哄鎵广€?* 姣忎釜 PR 閮介渶瑕侀櫎浣滆€呬箣澶栫殑涓€浜烘壒鍑嗭紙GitHub 涓嶅厑璁镐綔鑰呮壒鍑嗚嚜宸辩殑 PR锛夈€傚湪涓や汉缁勭粐涓紝杩欐剰鍛崇潃鍏朵腑涓€浜虹殑姣忎釜 PR 閮介渶瑕佸彟涓€浜烘壒鍑嗐€侱ependabot 鐨?PR 涓庤嚜鍔ㄥ寲 PR锛堝伐浣滄寚鏍囥€佹満鍣ㄤ汉鎻愪氦锛夊悓鏍烽渶瑕佷汉宸ユ壒鍑嗐€傞闄╋細濡傛灉涓€浜虹寮€锛屽氨娌℃湁浠讳綍涓滆タ鑳藉悎骞讹紝鑰屼笖娌℃湁缁曡繃涓讳綋鍙互閫€璺紙`bypass_actors: []`锛夈€?
2. **瀵规帶鍒惰矾寰勮姹?CODEOWNERS 瀹℃壒銆?* 寮€鍚?`require_code_owner_review`锛屽苟浣跨敤 `CODEOWNERS` 鏂囦欢锛坅ction-worker 宸叉湁锛沘i-gateway銆乤pp-source銆乪xternal-vault銆乮nternal-vault 鍦?ORG-009 鐨?PR 涓幏寰楀悇鑷殑鏂囦欢锛夈€侴itHub 鐨勮鍒欐槸鎸変粨搴撹€岄潪鎸夎矾寰勶細寮€鍚悗锛?*姣忎竴涓?*琚?CODEOWNERS 瑙勫垯瑕嗙洊鐨勬枃浠堕兘闇€瑕佹墍鏈夎€呮壒鍑嗭紝鑰?`*` 瑙勫垯瑕嗙洊涓€鍒囥€傝鎶婂畠闄愬埗鍒?`.github/workflows/**`銆乣policies/**`銆乣scripts/**`銆乣contracts/**`锛屽氨蹇呴』浠?CODEOWNERS 涓垹闄ゅ叏灞€鐨?`*` 琛岋紝杩欎細浣垮叾浠栬矾寰勪笉鍐嶅彈鎵€鏈夎€呰瘎瀹°€傝繖绛変环浜庨€夐」 1 鍐嶅姞涓婃寚瀹氳皝鍙互鎵瑰噯銆?
3. **涓ユ牸鐨勭姸鎬佹鏌ャ€?* `strict_required_status_checks_policy: true` 瑕佹眰鍒嗘敮鍦ㄥ悎骞跺墠涓?`main` 淇濇寔鏈€鏂帮紝浠庤€屼娇 `validate-merge` 鍦ㄥ悎骞剁粨鏋滀笂杩愯銆備唬浠凤細鍦ㄦ湰缁勭粐涓繛缁悎骞讹紝姣忎釜鏈叧闂殑 PR 閮藉繀椤诲湪姣忔鍚堝苟鍚庢洿鏂帮紙Dependabot 鐨?"rebase" 涓?`allow_update_branch` 鏈夋墍甯姪锛涜€屾垜鐨?PR 澶ч噺鍫嗗彔锛夈€?
4. **鎶?`validate-merge` 缁戝畾鍒板彂甯冨畠鐨勫簲鐢紙`integration_id`锛夈€?* 蹇呴渶妫€鏌ュ彲浠ユ寚瀹氬繀椤讳骇鐢熷畠鐨?GitHub App锛屼絾杩欏彧閫傜敤浜?checks锛圕hecks API锛夛紝涓嶉€傜敤浜庢櫘閫氱殑鎻愪氦鐘舵€併€俙validate-merge` 鐩墠鐢变护鐗屼互鎻愪氦鐘舵€佺殑褰㈠紡鍙戝竷銆傜粦瀹氶渶瑕佹敼鐢ㄥ垱寤?check run 鐨?GitHub App锛屾垨鑷冲皯鏀圭敤涓撶敤鐨?App 韬唤锛氳繖闇€瑕佹柊鐨勫熀纭€璁炬柦锛圓pp 娉ㄥ唽銆佸皢瀵嗛挜瀛樹负 secret銆佽疆鎹級銆傚湪姝や箣鍓嶏紝浠讳綍鎷ユ湁鍐欐潈闄愬拰浠ょ墝鐨勪汉閮借兘鍙戝竷璇ュ悕绉扮殑鐘舵€併€?
5. **鎶?`fongap` 鍔犱负缁曡繃涓讳綋**锛堟湭琚姹傦紝涔嬫墍浠ュ垪鍑猴紝鏄洜涓洪€夐」 1 鑷?3 浣垮叾鎴愪负蹇呰鐨勭揣鎬ヨ矾寰勶級銆傜粫杩囧簲闄愪簬"浠?pull request"妯″紡锛岃€岄潪"濮嬬粓"銆?

## 寤鸿锛堝垎闃舵锛?

1. **绉佹湁浠撳簱锛堝凡鍐冲畾锛屾棤闇€閰嶇疆锛夛細** 琛ュ伩鎬ф帶鍒舵槸 Main Write Guard锛屽畠宸茬粡瑕嗙洊鍏ㄩ儴涓冧釜浠撳簱銆俙intake.yml` 鐨?`Main write audit` 浣滀笟鍦ㄥ彈绠′粨搴?`main` push 缁忔ˉ鎺ュ敜閱掓椂鍗虫椂閲嶆柊瀹¤姣忎釜鍙楃鐨?`main`锛屽苟浠ュ畾鏃惰繍琛屽厹搴曪紙GitHub 瀹氭椂浠呭敖鍔涜€屼负锛屽疄闄呴棿闅斿彲鑳借揪鏁板皬鏃讹級锛涙棤娉曡拷婧埌閫氳繃纭畾鎬ч棬绂佺殑宸插悎骞?PR 鐨?`main` SHA锛屼細寰楀埌 `Main Write Guard = failure` 骞惰鏍囪涓轰笉鍙俊锛屽洜姝?Release銆丏eploy銆丳ublication 涓庣壒鏉冧换鍔￠兘浼氭嫆缁濆畠锛堝け璐ュ嵆鍏抽棴锛夈€?026-10-07锛屾墍鏈変竷涓粨搴撶殑 `main` 涓婅鐘舵€佸潎涓?`success`銆傚墿浣欓闄╅渶瑕佹槑纭鏄庯細绉佹湁浠撳簱鐨?`main` 涓婄殑鐩存帴 push 鏃犳硶琚樆姝紝鍙兘鍦ㄤ笅涓€娆″璁℃椂琚彂鐜帮紙閫氬父鐢?push 鍗虫椂瑙﹀彂锛屽畾鏃跺厹搴曪級锛屽苟涓旀嫆缁濆叾浠讳綍瀹樻柟杈撳嚭銆傚啓鏉冮檺搴斾粎闄愪簬涓ゅ悕缁存姢鑰咃紝骞朵繚鎸佸璁″伐浣滄祦鍋ュ悍锛涘け璐ユ垨杩囨湡鐨?`Main Write Guard` 鐘舵€佸氨鏄鎶ャ€?
2. **绗竴闃舵锛?* 瀵?PR 閲忚緝浣庣殑浠撳簱閲囩敤閫夐」 3锛堜弗鏍兼ā寮忥級锛岀劧鍚庤瀵熶竴鍛ㄣ€傚鏋滄坊鍔犱簡浠撳簱绾ц鐩栵紝鍒欓€氳繃浠撳簱绾ц鐩栧疄鏂斤紝鑰屼笉鏄€氳繃鍏变韩鏂囦欢锛涘惁鍒欏畠灏嗗簲鐢ㄤ簬鎵€鏈変粨搴撱€?
3. **绗簩闃舵锛?* 褰撳瓨鍦ㄧ浜屽悕甯歌璇勫鑰呮椂閲囩敤閫夐」 1锛堥€夐」 5 浣滀负绱ф€ヨ矾寰勶級銆傚湪姝や箣鍓嶄笉瑕侀噰鐢細鍦ㄤ袱浜哄姞涓婂ぇ閲忚嚜鍔ㄥ寲 PR 鐨勬儏鍐典笅锛屽畠浼氶樆濉炲伐浣溿€?
4. **绗笁闃舵锛?* 鍙湁鍦ㄥ洜鍏朵粬鍘熷洜寮曞叆 GitHub App 鏃舵墠閲囩敤閫夐」 4锛堝畠涔熸湁鍔╀簬 AW-002 涓?AW-007锛夈€?
5. 閫夐」 2 涓嶅€煎緱鍗曠嫭閲囩敤锛涗娇鐢ㄩ€夐」 1 鍗冲彲銆?
6. 浠ヤ笂姣忎竴椤?ruleset 鍙樻洿鍙奖鍝嶅洓涓叕寮€浠撳簱銆?

姣忎釜闃舵鐨勫洖婊氭柟寮忥細杩樺師 `policies/rulesets.json` 涓殑鍙樻洿锛涗笅涓€娆?apply 杩愯浼氭仮澶嶄箣鍓嶇殑瑙勫垯銆?

## 褰卞搷涓庨闄?

- 鍥犱负涓€娆″悎骞朵細鏀瑰彉姣忎釜鍙楃浠撳簱锛屽簲鍏堥€氳繃 `apply-repository-settings.yml` 鎵嬪姩杩愯 dry-run 妯″紡锛坄is_dry_run: true`锛夐拡瀵瑰崟涓粨搴撹繘琛岃瘯楠屻€?
- 瀵艰嚧 ruleset 鏃犳硶婊¤冻鐨勯敊璇紙渚嬪瑕佹眰瀹℃壒浣嗘棤浜鸿兘鎵瑰噯锛変細鍦ㄦ墍鏈変粨搴撲腑闃诲鍚堝苟锛屽寘鎷敤鏉ヤ慨澶嶅畠鐨勯偅涓?PR锛岄櫎闈炲瓨鍦ㄧ粫杩囦富浣撱€傚簲鍦ㄦ坊鍔犱换浣曞鎵硅姹傜殑鍚屼竴涓?PR 涓坊鍔犵粫杩囦富浣擄紝骞跺厛鎶婂鎵硅姹傚簲鐢ㄥ埌涓€涓粨搴撲笂銆?
- 鏈浼氳瘽鏈兘楠岃瘉锛圙itHub 鏂囨。鏃犳硶璁块棶锛夛細`integration_id` 鑳藉惁鍖归厤鎻愪氦鐘舵€佷笂涓嬫枃锛堟垜璁や负瀹冨彧閫傜敤浜?check run锛夈€傜鏈変粨搴撶殑 Free 濂楅闄愬埗宸蹭笉鍐嶆槸鏈喅闂锛氫笂鏂囧紩鐢ㄧ殑 API 鍝嶅簲宸茬粡纭浜嗗畠銆?

## 闇€瑕?owner 鍐冲畾

1. 閲囩敤鍝簺闃舵锛屼互鍙婃槸鍚︽帴鍙楁瘡涓?PR 閮介渶瑕佸鏂规壒鍑嗭紙绗簩闃舵锛夈€?
2. 锛堝凡纭畾锛夌鏈変粨搴撲緷闈?Main Write Guard锛汧ree 濂楅涓嬩笉鑳戒负绉佹湁浠撳簱璁剧疆 ruleset銆?
3. 鏄惁寮曞叆 GitHub App銆?
---
> **ORG-009 引用记录**：ai-gateway #78、external-vault #49、internal-vault #53、app-source #43（均为 CodeQL + CODEOWNERS / Dependabot + CODEOWNERS PR）。