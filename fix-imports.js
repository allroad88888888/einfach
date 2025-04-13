import fs from 'fs';
import path from 'path';

// 定义路径
const oldDir = path.join('packages', 'core', 'test', 'old');

// 递归获取所有测试文件
function getTestFiles(dir) {
  const files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    
    if (entry.isDirectory()) {
      files.push(...getTestFiles(fullPath));
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
  if (filePath.includes('\\utils\\')) {
    // 对于 utils 目录下的文件
    content = content.replace(/from ['"]\.\.\/\.\.\/src/g, 'from \'../../../src');
  } else {
    // 对于根目录下的文件
    content = content.replace(/from ['"]\.\.\/src/g, 'from \'../../src');
  }
  
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`Updated imports in: ${filePath}`);
}

// 主函数
function main() {
  try {
    const testFiles = getTestFiles(oldDir);
    console.log(`Found ${testFiles.length} test files to update.`);
    
    for (const file of testFiles) {
      updateImportPaths(file);
    }
    
    console.log('All import paths have been updated.');
  } catch (error) {
    console.error('Error:', error);
  }
}

main();
