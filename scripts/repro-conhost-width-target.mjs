const codePoint = Number.parseInt(process.argv[2], 16)
const mode = process.argv[3]
const symbol = String.fromCodePoint(codePoint)
const width = process.stdout.columns

if (mode === 'renderer') {
  const [React, { render, Text }] = await Promise.all([
    import('react'),
    import('../src/ui.js'),
  ])

  function Probe() {
    const [label, setLabel] = React.useState('FIRST')
    React.useEffect(() => {
      const timer = setTimeout(() => setLabel('SECOND'), 120)
      return () => clearTimeout(timer)
    }, [])
    return React.createElement(
      Text,
      null,
      `${'A'.repeat(width - 1)}${symbol}\n${label}`,
    )
  }

  const app = await render(React.createElement(Probe), {
    exitOnCtrlC: false,
    patchConsole: false,
  })
  await new Promise(resolve => setTimeout(resolve, 400))
  await app.unmount()
  process.exit(0)
} else {
  process.stdout.write('A'.repeat(width - 1) + symbol + '\r\nSECOND')
}
