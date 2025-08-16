### Thought

It was easier to test as a standalone extension without the replay script, i.e. have the replay baked inside of the extension.

Extensions are very cringe in that the state is completely lost when you defocus (this closes the panel). I ended up just running a setup script when you open the extension that sets up some window variables and opens a persistent panel. This avoids me having to do any funny cookies caching and below-the-(below-the-table) work.

I've never made a Chrome extension before, this was fun!

### replay.py

We use Playwright as that's the most straightforward option. The replay script from the extension can be repurposed here.

### Extension Usage

1. go to `chrome://extensions`. if you use arc like me it's actually at `arc://extensions/`.
2. load unpacked -> select "./extension" from this repo
3. use it idk
4. traces are saved to `${DOWNLOADS}/traces/*.json`
5. refresh button loads new things from trace (in case you drop somthing in yourself while it's open)
6. clear button unloads current trace (not sure why you would want to since dropdown auto loads trace)
7. play-pause button... well, play-pauses
8. orange ball can be dragged up and down to scrub through timeline
9. hover over timeline items to see trace item

### Python Usage

1. run `pipi.sh`
2. source .venv/bin/activate
3. run `python3 replay.py --file TRACENAME` (optional `-v` for verbose)

Note: this may trigger google's "weird ass behavior" captcha guard, as playwright is a bot on unbranded chromium.

**Caution**: Do not move the mouse inside of the launched Chromium window. Weird things will happen with mouse events, particularly drag events.

### ChatGPT Doesn't F**king Work

ChatGPT's website is kind of dumb, when you press (+) then "more" to get web search, clicking on "more" itself will actually just close the entire dropdown. I think that's unexpected behavior (it really should keep the "more" hover popover permanently open instead or something) - so unexpected that chrome devtools recorder itself cannot properly emulate it (LOL) (it fails with 5000 ms timeout).

I tried simulating a conversation (just in general) but Chromium (what Playwright uses) triggers GPT-5's stupid "sign up for our thing now!!!" dialog box (can't be canceled by the way, used to not be there)

### Most Things Don't Work Either

Everything triggers some captcha or some "you're using a robot to automate things noooooo" so I found soe 
