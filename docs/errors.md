# Error handling

Nothing crashes on a sensor or network problem; everything retries on its own.

## Terminal (the servers)

- One timestamped line per problem when it starts or changes, e.g. `[21:22:38] sensor (CoLa): timed out (retrying every 3 s)`.
- A reminder once a minute while it persists, and `… ok again` when it clears. No tracebacks.
- **Sensor:** the CoLa stream and the REST status poll reconnect every 3 s. A connection problem aborts a REST batch at once instead of waiting out one timeout per variable.
- **Recording:** a disk error (e.g. disk full) stops the recording with a message; the live stream keeps going. So does a change of the scan layout mid-recording. What was recorded until then is kept.
- **Replay:** if the recording is deleted or unreadable, its replays end (`closed` with the reason) and the viewer returns to live, showing the reason on the page.
- **Between the servers:** a processing server whose connection to the source drops reconnects every 2 s and starts its live histories afresh; a replay belongs to its connection and ends with it. `GET /api/state` of a processing server shows the source connection's error.
- **HTTP:**
  - Bad requests get a short JSON `{"error": …}` with status 400/404/422; a change from another web page 403, without the admin token 401.
  - Browsers closing connections are ignored.
  - Unexpected errors give one log line and a 500.
- **Safety net:** each background loop (a sensor's status poll) is supervised and restarted if it ever dies.
- **Startup:** a port already in use prints `error: cannot listen on … (settings in <database>)` and exits ([setup.md](setup.md#common-problems) says how to give it another one). A start replay that cannot open (the debug server's setting) is logged and the server carries on.
- **Settings:** a refused change (`PUT /api/settings`: an unknown key, a bad value, a port that is taken, a recordings folder while recording, an unknown start replay) is a 400 or 404 with the field's name, and changes nothing.

## Browser

- One console line per problem (`[server]`, `[sensor]`, `[replay]`, `[processing]`) and one when it clears.
- Active problems are listed in the panel.
- The frame poll retries after 1 s, backing off to every 5 s.
- An exception while processing a frame is reported, but the stream continues.

## CLI (`mrs6000`)

Prints `error: <short reason>` and exits with status 1.
