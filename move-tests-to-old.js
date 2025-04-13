import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// 获取当前文件的目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 定义路径
const testDir = path.join('packages', 'core', 'test');
const oldDir = path.join(testDir, 'old');
const utilsOldDir = path.join(oldDir, 'utils');

// 确保目标目录存在
if (!fs.existsSync(oldDir)) {
  fs.mkdirSync(oldDir, { recursive: true });
}

if (!fs.existsSync(utilsOldDir)) {
  fs.mkdirSync(utilsOldDir, { recursive: true });
}

// 获取测试文件列表（排除 old 目录）
function getTestFiles(dir) {
  const files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    
    if (entry.isDirectory()) {
      if (entry.name !== 'old') {
        files.push(...getTestFiles(fullPath));
      }
    } else if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) {
      files.push(fullPath);
    }
  }
  
  return files;
}

// 更新文件中的引用路径
function updateImportPaths(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  
  // 更新引用路径
  content = content.replace(/from ['"]\.\.\/src['"]/g, 'from \'../../src\'');
  content = content.replace(/from ['"]\.\.\/\.\.\/src['"]/g, 'from \'../../../src\'');
  
  fs.writeFileSync(filePath, content, 'utf8');
}

// 移动文件并更新引用
function moveFile(sourcePath) {
  const relativePath = path.relative(testDir, sourcePath);
  const dirName = path.dirname(relativePath);
  const fileName = path.basename(sourcePath);
  
  let destDir;
  if (dirName === '.') {
    destDir = oldDir;
  } else {
    destDir = path.join(oldDir, dirName);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
  }
  
  const destPath = path.join(destDir, fileName);
  
  // 复制文件
  fs.copyFileSync(sourcePath, destPath);
  
  // 更新引用路径
  updateImportPaths(destPath);
  
  console.log(`Moved: ${sourcePath} -> ${destPath}`);
  
  // 删除原文件
  fs.unlinkSync(sourcePath);
}

// 主函数
function main() {
  try {
    const testFiles = getTestFiles(testDir);
    console.log(`Found ${testFiles.length} test files to move.`);
    
    for (const file of testFiles) {
      moveFile(file);
    }
    
    console.log('All test files have been moved to the old directory and references updated.');
  } catch (error) {
    console.error('Error:', error);
  }
}

main();
