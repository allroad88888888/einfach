// Windows兼容的文件清理脚本
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 新的包名称
const packages = ['react', 'solid', 'vanilla']

// 需要删除的目录和文件后缀
const targets = ['tsconfig.tsbuildinfo', 'es', 'esm', 'cjs', '@types', 'dist']

try {
  console.log(`Found ${packages.length} packages to process`)

  // 处理每个包
  for (const pkg of packages) {
    const pkgPath = path.join(__dirname, pkg)

    // 跳过不存在的包目录
    if (!fs.existsSync(pkgPath)) {
      console.log(`Package directory not found: ${pkgPath}, skipping`)
      continue
    }

    // 获取子目录
    const subDirs = fs
      .readdirSync(pkgPath, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name)

    // 遍历子目录
    for (const subDir of subDirs) {
      const subDirPath = path.join(pkgPath, subDir)

      // 对每个子目录处理目标
      for (const target of targets) {
        const targetPath = path.join(subDirPath, target)

        if (fs.existsSync(targetPath)) {
          if (target === 'tsconfig.tsbuildinfo') {
            // 删除文件
            fs.unlinkSync(targetPath)
            console.log(`Deleted file: ${targetPath}`)
          } else {
            // 删除目录
            fs.rmSync(targetPath, { recursive: true, force: true })
            console.log(`Deleted directory: ${targetPath}`)
          }
        }
      }
    }
  }

  console.log('Cleanup completed successfully')
} catch (error) {
  console.error('Error during cleanup:', error)
  process.exit(1)
}
