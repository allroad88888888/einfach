export function htmlToHump(html: string) {
  return html.replace(/([a-z]+)[-:]([a-z])([a-z]+)/g, function (match, p1, p2, p3) {
    return `${p1}${p2.toString().toLocaleUpperCase()}${p3}`
  })
}
