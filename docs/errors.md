# Error handling

Nothing crashes on a sensor or network problem; everything retries on its own.

## Terminal (backend)

- One timestamped line per problem when it starts or changes, e.g. `[21:22:38] sensor (CoLa): timed out (retrying every 3 s)`.
- A reminder once a minute while it persists, and `… ok again` when it clears. No tracebacks.
- **Sensor:** the CoLa stream and the REST status poll reconnect every 3 s. A connection problem aborts a REST batch at once instead of waiting out one timeout per variable.
- **Recording:** a disk error (e.g. disk full) stops the recording with a message; the live stream keeps going. So does a change of the scan layout mid-recording. What was recorded until then is kept.
- **Replay:** if the recording is deleted or unreadable, the viewer returns to live and shows the reason on the page.
- **HTTP:**
  - Bad requests get a short JSON `{"error": …}` with status 400/404.
  - Browsers closing connections are ignored.
  - Unexpected errors give one log line and a 500.
- **Safety net:** each background thread is supervised and restarted if it ever dies.
- **Startup:** a port already in use prints `error: cannot listen on …` and exits. A bad `--replay`/`--record` file is logged and the viewer continues live.

## Browser

- One console line per problem (`[server]`, `[sensor]`, `[replay]`, `[processing]`) and one when it clears.
- Active problems are listed in the panel.
- The frame poll retries after 1 s, backing off to every 5 s.
- An exception while processing a frame is reported, but the stream continues.

## CLI (`mrs6000`)

Prints `error: <short reason>` and exits with status 1.
