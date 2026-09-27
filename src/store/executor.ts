import type { ReservedSQL } from "bun";

export const executorLockKey = [1_297_043_787, 1] as const;

export async function tryAcquireExecutorLock(
  session: ReservedSQL,
): Promise<boolean> {
  const [row] = await session<{ acquired: boolean }[]>`
    SELECT pg_try_advisory_lock(${executorLockKey[0]}, ${executorLockKey[1]}) AS acquired
  `;
  return row?.acquired === true;
}

export async function releaseExecutorLock(session: ReservedSQL): Promise<void> {
  const [row] = await session<{ released: boolean }[]>`
    SELECT pg_advisory_unlock(${executorLockKey[0]}, ${executorLockKey[1]}) AS released
  `;
  if (row?.released !== true)
    throw new Error("PostgreSQL 执行器会话锁已丢失，无法确认解锁。");
}

export async function assertExecutorLock(session: ReservedSQL): Promise<void> {
  const [row] = await session<{ held: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM pg_locks
      WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted
        AND classid = ${executorLockKey[0]}::oid
        AND objid = ${executorLockKey[1]}::oid AND objsubid = 2
    ) AS held
  `;
  if (row?.held !== true)
    throw new Error("PostgreSQL 执行器会话锁已丢失，执行已停止。");
}
