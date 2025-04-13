// Windows兼容的文件清理脚本
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packagesDir = path.join(__dirname, 'packages');

// 需要删除的目录和文件后缀
const targets = ['tsconfig.tsbuildinfo', 'es', 'esm', 'cjs', '@types', 'dist'];

try {
  // 确保packages目录存在
  if (!fs.existsSync(packagesDir)) {
    console.log('Packages directory not found, skipping cleanup');
    process.exit(0);
  }

  // 读取packages目录中的所有包
  const packages = fs.readdirSync(packagesDir, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);
  
  console.log(`Found ${packages.length} packages to process`);
  
  // 处理每个包
  for (const pkg of packages) {
    const pkgPath = path.join(packagesDir, pkg);
    
    for (const target of targets) {
      const targetPath = path.join(pkgPath, target);
      
      if (fs.existsSync(targetPath)) {
        if (target === 'tsconfig.tsbuildinfo') {
          // 删除文件
          fs.unlinkSync(targetPath);
          console.log(`Deleted file: ${targetPath}`);
        } else {
          // 递归删除目录
          fs.rmSync(targetPath, { recursive: true, force: true });
          console.log(`Deleted directory: ${targetPath}`);
        }
      }
    }
  }
  
  console.log('Cleanup completed successfully');
} catch (error) {
  console.error('Error during cleanup:', error);
  process.exit(1);
} 