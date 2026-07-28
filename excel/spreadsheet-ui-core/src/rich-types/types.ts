export interface HyperlinkValue {
  kind: 'hyperlink'
  url: string
  label: string
}

export interface RichTextRunFormat {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
  color?: string
}

export interface RichTextRun {
  text: string
  format?: RichTextRunFormat
}

export interface RichTextValue {
  kind: 'rich-text'
  runs: RichTextRun[]
}

export interface RichNumberValue {
  kind: 'number'
  value: number
  displayHint?: string
}

export interface RichBooleanValue {
  kind: 'boolean'
  value: boolean
}

export interface RichErrorValue {
  kind: 'error'
  code: string
  message: string
}

export type DisplayCellRichValue =
  | HyperlinkValue
  | RichTextValue
  | RichNumberValue
  | RichBooleanValue
  | RichErrorValue
