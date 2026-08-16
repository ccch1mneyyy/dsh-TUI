/** Regression check for raw background colors on the public themed Text. */

process.env.FORCE_COLOR = '3'

const [{ PassThrough, Writable }, React, { render, ThemeProvider, Text }] =
  await Promise.all([
    import('node:stream'),
    import('react'),
    import('../src/ui.js'),
  ])

class FakeStdout extends Writable {
  columns = 80
  rows = 24
  isTTY = true
  frames: string[] = []

  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    this.frames.push(String(chunk))
    callback()
  }
}

class FakeStderr extends Writable {
  isTTY = true

  _write(_chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    callback()
  }
}

class FakeStdin extends PassThrough {
  isTTY = true

  setRawMode() {
    return this
  }

  ref() {
    return this
  }

  unref() {
    return this
  }
}

const stdout = new FakeStdout()
const instance = await render(
  <ThemeProvider theme="dark">
    <Text backgroundColor="#ffd75f"> TEXT-BG </Text>
  </ThemeProvider>,
  {
    stdout: stdout as NodeJS.WriteStream,
    stdin: new FakeStdin() as NodeJS.ReadStream,
    stderr: new FakeStderr() as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  },
)

await new Promise(resolve => setTimeout(resolve, 100))
await instance.unmount()

const output = stdout.frames.join('')
if (!output.includes('\x1b[48;2;255;215;95m')) {
  throw new Error('Text raw backgroundColor did not reach terminal output')
}

process.stdout.write('text background color regression passed\n')
