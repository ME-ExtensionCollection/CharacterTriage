# Char Triage

A Marinara Engine External Extension for cleaning up big, bulk-imported character libraries. It has your own vision model look at every card's avatar, gives every card **picture tags** (what is actually in the image, including categories you define), learns from the cards you keep and delete, and scores every card by how likely you are to dislike it. With [Character Library](../CharacterLib) installed, the Character Manager can search the picture tags and sort and filter by the score, so the cards worth reviewing come first.

## How it works

1. **Scan.** Each avatar is shrunk to 512 px and sent to a vision model through one of your Marinara connections. Built-in questions: art style, AI artifacts, image quality, low effort (screenshots, memes, text), text or watermarks, NSFW, framing, number of characters, gender presentation, species, background, colours, mood, and **every danbooru-style tag that fits** (no limit; a guard at 100 only stops a runaway reply, and the Storage section counts any reply that hit it). Plus one 0–3 question per **category** you turn on, and the dislike profile if you wrote one. The model must answer in JSON (a JSON schema is sent), with thinking turned off.
   Each question has its own version. Adding a category, rewording one, or editing the profile only asks that question again; a card whose avatar file changed is asked everything again. Scans from 0.1 keep their answers and only get the new questions.
2. **Decide.** As you work in the Character Manager, every delete is logged as "dislike" and every **Keep** as "fine". Cards you open in the details pane and don't delete count as a weak keep.
3. **Learn.** A small logistic regression runs in the browser on the answers plus the card's tags and creator. It retrains a moment after each batch of decisions and scores every card from 0 to 1, shown on cards as 0 (likely fine) to 5 (likely disliked): the score × 5, rounded, so 3 is a coin toss.

Before you have about 30 decisions (at least 5 deletes and 5 keeps), the score comes from the optional **dislike profile**: a few lines describing what you don't like, which the model rates each image against.

**Not every delete is about the picture.** *Learn from deletes by default* sets whether deletes teach the model, and the Character Manager's delete dialog can change it per card. Deletes that don't teach the model still count toward *Tags you delete*.

## The panel

Open it with **Alt+Shift+T**, or the Triage button in the Character Manager.

- **Vision model**: the connection to use (any chat connection whose model reads images, such as llama.cpp started with `--mmproj`), the dislike profile, the learn-from-deletes default, and **Pause automatic keeps**: while it is on, cards you open and don't delete are not counted as fine (handy while you hunt one category and leave the rest for later).
- **Categories**: things you want found in pictures. Examples to add with one click: hyper anatomy, inflation, weight gain, body horror, gore / guro, dismemberment / amputation, vore. Add your own with a name and what to look for. Each is answered 0 none, 1 a hint, 2 clearly shown, 3 the focus, and becomes a picture tag: `image:inflation` is any level, `image:inflation:2` two or more. Each shows how many pictures it has been asked on. *Remove* stops asking; its answers stay until *Clean up*.
- **Scan**: *Scan library* asks every card the questions it hasn't been asked yet, newest first. Cards you already decided on go before the rest, because they are what the model learns from. It runs while Marinara is open, picks up again after a reload, and only runs in one tab. *Requests at once* should match llama.cpp's `--parallel`. *Pilot* scans only up to 300 cards you already decided on, so you can check the model against your own calls before the full run. Identical images (re-imports) are asked about once. Avatars of cards deleted before they were scanned are kept in a small copy and scanned later, so those decisions still count. To scan only some cards, select them in the Character Manager and use **Ask Char Triage**; they jump the queue of a running scan.
- **What it learned**: how many decisions it uses, how often it predicts your call on decisions it was not trained on, how many cards fall in each score band, and the strongest signals each way.
- **Tags you delete**: *Card tags* or *Picture tags* on at least 5 deleted cards that you delete more often than your overall rate, strongest first (smoothed, so 30 of 32 beats 6 of 6). Each tag has **Copy**, and card tags have **Blacklist**, which adds it to Char Importer's profile tag blacklist (needs a Char Importer version with its sharing API).
- **Backup**: decisions and scans live in this browser's IndexedDB, not on the server. **Export…** saves everything to a dated JSON file; **Import…** merges a file back in (the decision logs are combined, and scans merge question by question, newer answer winning). A notice offers an export after every 200 new decisions.
- **Storage**: how many scans, decisions and kept avatars there are, and how much the browser reports this site using. Everything is in IndexedDB, not Marinara's 1 MB extension storage (only settings and categories go there). **Clean up** removes scans of cards that are gone and that no decision refers to, kept avatars no longer needed, and answers to removed categories. Decisions are never removed. **Clear everything** wipes this browser's data after you type CLEAR.

## Speed

On Qwen 3.6 35B A3B (llama.cpp, Q4, f16 vision, 4 parallel), 0.1's questions took about 1.2 s per card with 4 at once, roughly 4.5 hours for 14,000 cards. The full tag list and categories add output, so expect somewhat more; later runs that only ask a new category are much shorter replies. Each card is two requests to Marinara (avatar and model), well inside its limit of 600 a minute. A "too many requests" answer pauses the scan for as long as Marinara asks. Dropped connections and server errors are retried, and after 10 failures in a row the scan stops and shows the error.

## For other extensions

`window.marinaraCharTriage` (version 1):

| Method | |
| --- | --- |
| `ready()` | resolves when settings, scans and decisions are loaded |
| `scores()` | `Map` card id → score 0..1 (cards without evidence are missing) |
| `scoreOf(id)`, `bucketOf(id)` | one card's score, or its 0–5 number |
| `answers(id)` | the vision model's answers for a card, or `null` |
| `decisionOf(id)` | `"delete"`, `"keep"`, `"implied-keep"` or `null` |
| `decisions()` | `Map` card id → its latest decision |
| `learnFromDeletes()` | the default for the delete dialog |
| `beforeDelete(cards, { learnById })` | log deletes (call before deleting); `learnById` overrides the default per card |
| `recordKeep(idsOrCards, { implied })` | log keeps |
| `scanState()` | progress of the current or last scan |
| `imageTags()`, `imageTagsOf(id)` | picture tags (`image:…`): a `Map` card id → list, a new map whenever they change |
| `scanCards(ids)` | ask about these cards now (only what each still needs); resolves with how many had something to ask |
| `openPanel()` | open the panel |

`marinara-char-triage:changed` fires on `window` when scores change. Check for the methods you need, not the version.

## Install

Needs **Full page access** (it runs in Marinara's page with the same authority as code pasted into the browser console), so read the files in `extension/` before you approve them. Import the `extension/` folder as an External Extension.

## Development

```sh
npm run check   # build check + unit tests
npm run dev     # harness on http://localhost:5180/dev/harness.html (mock Marinara + fake vision model)
CTR_PLAYWRIGHT=/path/to/playwright-core CTR_CHROME=/usr/bin/google-chrome-stable npm run smoke
```
