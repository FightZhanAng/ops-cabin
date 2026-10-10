import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 原子写文件：写临时文件 → fsync → rename 覆盖。
 * 断电或崩溃时要么是完整的旧文件、要么是完整的新文件，不会出现半截内容。
 * 失败会抛异常，由调用方决定是中止还是忽略。
 */
export function writeFileAtomic(file: string, data: string): void {
  const tmp = `${file}.tmp`
  mkdirSync(dirname(file), { recursive: true })
  const fd = openSync(tmp, 'w')
  try {
    writeFileSync(fd, data, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, file)
}
