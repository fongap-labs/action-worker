from __future__ import annotations

import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import db


class BindingAtomicityTests(unittest.TestCase):
    def setUp(self) -> None:
        self._temp = tempfile.TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self._old_path = db.DB_PATH
        db.DB_PATH = Path(self._temp.name) / "license.db"
        self.addCleanup(setattr, db, "DB_PATH", self._old_path)
        db.init_db()
        self.code_id = db.create_redeem_code(
            "a" * 64, "securepigeon", "pro", 3
        )

    def test_concurrent_instances_cannot_double_bind_one_code(self) -> None:
        barrier = threading.Barrier(2)

        def redeem(instance_id: str) -> tuple[str, int | None]:
            barrier.wait()
            return db.bind_code_once(self.code_id, instance_id)

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(redeem, ["SP-AAAA-BBBB-CCCC", "SP-DDDD-EEEE-FFFF"]))

        states = sorted(state for state, _ in results)
        self.assertEqual(states, ["conflict", "created"])

        conn = db.get_db()
        try:
            active = conn.execute(
                "SELECT instance_id FROM bindings "
                "WHERE redeem_code_id = ? AND status = 'active'",
                (self.code_id,),
            ).fetchall()
        finally:
            conn.close()
        self.assertEqual(len(active), 1)

    def test_unbound_instance_can_be_reactivated(self) -> None:
        state, binding_id = db.bind_code_once(self.code_id, "SP-AAAA-BBBB-CCCC")
        self.assertEqual(state, "created")
        self.assertIsNotNone(binding_id)

        db.unbind(self.code_id, "SP-AAAA-BBBB-CCCC")
        state, rebound_id = db.bind_code_once(self.code_id, "SP-AAAA-BBBB-CCCC")
        self.assertEqual(state, "created")
        self.assertEqual(rebound_id, binding_id)

        state, same_id = db.bind_code_once(self.code_id, "SP-AAAA-BBBB-CCCC")
        self.assertEqual(state, "existing")
        self.assertEqual(same_id, binding_id)


if __name__ == "__main__":
    unittest.main()
