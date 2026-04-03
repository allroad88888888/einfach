
import { Table } from '../Table'
import { createSheetStore } from '../sheet-store'
import { createJSSheet } from '../js-sheet'

/**
 * Demo 4: 学生成绩计算器
 */
export function DemoGrades() {
  const store = createSheetStore(createJSSheet())

  // 表头
  store.setText('A1', 'Student')
  store.setText('B1', 'Math')
  store.setText('C1', 'English')
  store.setText('D1', 'Science')
  store.setText('E1', 'Average')
  store.setText('F1', 'Max')
  store.setText('G1', 'Min')

  // 学生数据
  const students = [
    ['Alice',   92, 88, 95],
    ['Bob',     78, 85, 72],
    ['Charlie', 95, 92, 98],
    ['Diana',   63, 70, 68],
    ['Eve',     88, 91, 85],
    ['Frank',   45, 52, 48],
    ['Grace',   100, 97, 99],
    ['Henry',   72, 68, 75],
  ]

  students.forEach(([name, math, eng, sci], i) => {
    const row = i + 2
    store.setText(`A${row}`, name as string)
    store.setNumber(`B${row}`, math as number)
    store.setNumber(`C${row}`, eng as number)
    store.setNumber(`D${row}`, sci as number)
    store.setFormula(`E${row}`, `=AVERAGE(B${row},C${row},D${row})`)
    store.setFormula(`F${row}`, `=MAX(B${row},C${row},D${row})`)
    store.setFormula(`G${row}`, `=MIN(B${row},C${row},D${row})`)
  })

  // 汇总行
  const lastRow = students.length + 2
  store.setText(`A${lastRow}`, '--- Summary ---')

  const statRow = lastRow + 1
  store.setText(`A${statRow}`, 'Class Avg')
  store.setFormula(`B${statRow}`, `=AVERAGE(B2,B3,B4,B5,B6,B7,B8,B9)`)
  store.setFormula(`C${statRow}`, `=AVERAGE(C2,C3,C4,C5,C6,C7,C8,C9)`)
  store.setFormula(`D${statRow}`, `=AVERAGE(D2,D3,D4,D5,D6,D7,D8,D9)`)

  const maxRow = statRow + 1
  store.setText(`A${maxRow}`, 'Highest')
  store.setFormula(`B${maxRow}`, `=MAX(B2,B3,B4,B5,B6,B7,B8,B9)`)
  store.setFormula(`C${maxRow}`, `=MAX(C2,C3,C4,C5,C6,C7,C8,C9)`)
  store.setFormula(`D${maxRow}`, `=MAX(D2,D3,D4,D5,D6,D7,D8,D9)`)

  const minRow = maxRow + 1
  store.setText(`A${minRow}`, 'Lowest')
  store.setFormula(`B${minRow}`, `=MIN(B2,B3,B4,B5,B6,B7,B8,B9)`)
  store.setFormula(`C${minRow}`, `=MIN(C2,C3,C4,C5,C6,C7,C8,C9)`)
  store.setFormula(`D${minRow}`, `=MIN(D2,D3,D4,D5,D6,D7,D8,D9)`)

  const countRow = minRow + 1
  store.setText(`A${countRow}`, 'Count')
  store.setFormula(`B${countRow}`, `=COUNT(B2,B3,B4,B5,B6,B7,B8,B9)`)

  return (
    <div class="demo-page">
      <div class="demo-header">
        <h3>Grade Calculator</h3>
        <p class="demo-desc">
          Edit any score — <strong>Average</strong>, <strong>Max</strong>, <strong>Min</strong>,
          and class statistics all recalculate instantly.
          Each student's row uses <code>AVERAGE</code>, <code>MAX</code>, <code>MIN</code>.
        </p>
      </div>
      <Table store={store} rows={14} cols={8} />
    </div>
  )
}
