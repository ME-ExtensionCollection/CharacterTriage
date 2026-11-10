# Char Triage

A Marinara Engine External Extension for cleaning up big, bulk-imported character libraries. It has your own vision model look at every card's avatar once, learns from the cards you keep and delete, and scores every card by how likely you are to dislike it. With [Character Library](../CharacterLib) installed, the Character Manager can sort and filter by that score, so the cards worth reviewing come first.

## How it works

1. **Scan.** Each avatar is shrunk to 512 px and sent to a vision model through one of your Marinara connections, with a fixed list of questions: art style, AI artifacts, image quality, low effort (screenshots, memes, text), text or watermarks, NSFW, gore, framing, number of characters, gender presentation, species, background, colours, mood, and a short caption. The model must answer in JSON (a JSON schema is sent), with thinking turned off.
2. **Decide.** As you work in the Character Manager, every delete is logged as "dislike" and every **Keep** as "fine". Cards you open in the details pane and don't delete count as a weak keep.
3. **Learn.** A small logistic regression runs in the browser on the answers plus the card's tags and creator. It retrains a moment after each batch of decisions and scores every card from 0 to 1, shown as 1 (likely fine) to 5 (likely disliked).

Before you have about 30 decisions (at least 5 deletes and 5 keeps), the score comes from the optional **dislike profile**: a few lines describing what you don't like, which the model rates each image against.

**Not every delete is about the picture.** *Learn from deletes by default* sets whether deletes teach the model, and the Character Manager's delete dialog can change it per card. Deletes that don't teach the model still count toward *Tags you delete*.

## The panel

Open it with **Alt+Shift+T**, or the Triage button in the Character Manager.

- **Vision model**: the connection to use (any chat connection whose model reads images, such as llama.cpp started with `--mmproj`), the dislike profile, and the learn-from-deletes default.
- **Scan**: *Scan library* scans every card not scanned yet, newest first. Cards you already decided on go before the rest, because they are what the model learns from. It runs while Marinara is open, picks up again after a reload, and only runs in one tab. *Requests at once* should match llama.cpp's `--parallel`. *Pilot* scans only up to 300 cards you already decided on, so you can check the model against your own calls before the full run. Identical images (re-imports) are asked about once. Avatars of cards deleted before they were scanned are kept in a small copy and scanned later, so those decisions still count.
- **What it learned**: how many decisions it uses, how often it predicts your call on decisions it was not trained on, how many cards fall in each score band, and the strongest signals each way.
- **Tags you delete**: tags on at least 5 deleted cards that you delete more often than your overall rate, strongest first (smoothed, so 30 of 32 beats 6 of 6). Each tag has **Copy**, and **Blacklist** adds it to Char Importer's profile tag blacklist (needs a Char Importer version with its sharing API).
- **Backup**: decisions and scans live in this browser's IndexedDB, not on the server. **Export…** saves everything to a dated JSON file; **Import…** merges a file back in (the decision logs are combined, and the newer scan wins). A notice offers an export after every 200 new decisions.

Changing the dislike profile changes the questions, so cards are scanned again on the next run.

## Speed

On Qwen 3.6 35B A3B (llama.cpp, Q4, f16 vision, 4 parallel) one image takes about 1.5 s, or about 0.85 s each with 4 at once: roughly 3.5 hours for 14,000 cards. Each card is two requests to Marinara (avatar and model), well inside its limit of 600 a minute. A "too many requests" answer pauses the scan for as long as Marinara asks. Dropped connections and server errors are retried, and after 10 failures in a row the scan stops and shows the error.

## For other extensions

`window.marinaraCharTriage` (version 1):

| Method | |
| --- | --- |
| `ready()` | resolves when settings, scans and decisions are loaded |
| `scores()` | `Map` card id → score 0..1 (cards without evidence are missing) |
| `scoreOf(id)`, `bucketOf(id)` | one card's score, or its 1–5 band |
| `answers(id)` | the vision model's answers for a card, or `null` |
| `decisionOf(id)` | `"delete"`, `"keep"`, `"implied-keep"` or `null` |
| `learnFromDeletes()` | the default for the delete dialog |
| `beforeDelete(cards, { learnById })` | log deletes (call before deleting); `learnById` overrides the default per card |
| `recordKeep(idsOrCards, { implied })` | log keeps |
| `scanState()` | progress of the current or last scan |
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
