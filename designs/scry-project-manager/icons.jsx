// 图标集：形状取自 scry src/renderer/components/primitives/Icon.tsx 的线性 24 网格风格，
// 新增 pin / archive / trash / filter / folder 五个本设计需要的图形。
const ICON_PATHS = {
  plus: 'M12 5v14M5 12h14',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.35-4.35',
  chevronRight: 'M9 18l6-6-6-6',
  chevronDown: 'M6 9l6 6 6-6',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 8h.01M11 12h1v5h1',
  box: 'M21 8 12 3 3 8v8l9 5 9-5V8ZM3 8l9 5 9-5M12 13v8',
  cube: 'M12 2 3 7v10l9 5 9-5V7l-9-5ZM7 4.5l10 5.5M12 22V12',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7.9 19l-.1.1A2 2 0 1 1 5 16.3l.1-.1A1.6 1.6 0 0 0 4 13.5H4a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 5.6 6.8l-.1-.1A2 2 0 1 1 8.3 4l.1.1A1.6 1.6 0 0 0 11 3V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1A2 2 0 1 1 20.6 7l-.1.1a1.6 1.6 0 0 0 1.1 2.7H22a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1.1Z',
  x: 'M18 6 6 18M6 6l12 12',
  check: 'M20 6 9 17l-5-5',
  pin: 'M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1v3.76Z',
  archive: 'M3 4h18v5H3zM20 9v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9M10 13h4',
  unarchive: 'M3 4h18v5H3zM20 9v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9M12 18v-6M9.5 14.5 12 12l2.5 2.5',
  trash: 'M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M10 11v6M14 11v6',
  filter: 'M4 6h16M7 12h10M10 18h4',
  folder: 'M3 7a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z',
  undo: 'M4 10h11a4 4 0 0 1 0 8H9M4 10l4-4M4 10l4 4',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  edit: 'M4 20h4L19 9a2.1 2.1 0 0 0-4-4L4 16v4ZM13.5 6.5l4 4',
  external: 'M14 4h6v6M20 4l-9 9M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6',
  arrowUp: 'M12 19V5M6 11l6-6 6 6',
  terminal: 'M4 6l5 5-5 5M11 18h9'
}

function Icon({ name, className }) {
  const d = ICON_PATHS[name]
  if (!d) return null
  return (
    <svg
      className={['ico', className].filter(Boolean).join(' ')}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {d.split('M').filter(Boolean).map((seg, i) => (
        <path key={i} d={`M${seg}`} />
      ))}
    </svg>
  )
}

Object.assign(window, { Icon, ICON_PATHS })
