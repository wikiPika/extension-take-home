### Thought

It was easier to test as a standalone extension without the replay script, i.e. have the replay baked inside of the extension.

Extensions are very cringe in that the state is completely lost when you defocus (this closes the panel). I ended up just running a setup script when you open the extension that sets up some window variables and opens a persistent panel. This avoids me having to do any funny cookies caching and below-the-(below-the-table) work.

### replay.py

We use Playwright as that's the most straightforward option. The replay script from the extension can be repurposed here.

### Extension Usage

1. go to `chrome://extensions`. if you use arc like me it's actually at `arc://extensions/`.
2. load unpacked -> select "./extension" from this repo
3. use it idk
4. traces are saved to `${DOWNLOADS}/traces/*.json`

### Python Usage

1. run `pipi.sh`
2. source .venv/bin/activate
3. run `python3 replay.py --file TRACENAME` (optional `-v` for verbose)

note: this may trigger google's "weird ass behavior" guard, as playwright is a bot.

### ChatGPT trace

Please select ChatGPT 5 (no thinking, no thoughts, head empty) for the trace.
