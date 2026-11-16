# Flashpoint

Hot-potato chemistry party game for 2–8 players. Each round shows a category ("Name a weak acid"). Whoever holds the bubbling flask has to type a valid, unused answer to pass it on before it boils over.

## Run it locally

```bash
npm install
npm start            # http://localhost:3000
```

Open three tabs to play against yourself. Each tab keeps its own seat, and reloading a tab rejoins the same game.

## Tests

```bash
npm test               # answer matching, content checks, full multiplayer game over real sockets
npm run test:browser   # three Chrome tabs play a whole game; screenshots go to test-artifacts/
```

The browser test needs Google Chrome. Set `CHROME_PATH` if Chrome isn't installed in `/Applications`.

## How it's built

| File | What it does |
| --- | --- |
| `server.js` | Express plus Socket.io. Serves `public/`, keeps rooms in memory and relays events |
| `src/game.js` | Room state machine: lobby → playing → results, turns, the fuse timer, lives, the 30s rejoin window |
| `src/answers.js` | Answer normalisation and matching: case, spaces, accents, sub/superscripts, one typo on long words |
| `data/categories.json` | All the questions (see below) |
| `public/` | The client: `app.js` (UI), `sound.js` (Web Audio sound effects, no audio files), `style.css` |

The server owns every rule: who holds the flask, the deadline, and answer checking. Clients only render.

Timings live in `src/game.js` (`DEFAULTS`). You can override them with the `FLASK_START_MS`, `FLASK_STEP_MS`, `FLASK_MIN_MS`, `INTERMISSION_MS` and `REJOIN_MS` environment variables.

## Adding categories or a new difficulty

Difficulties are listed in `data/categories.json`:

```json
{
  "levels": [{ "id": "central-science", "name": "General Chem", "source": "Brown et al., 14th ed." }],
  "categories": [
    {
      "id": "weak-acid",
      "prompt": "Name a weak acid",
      "levels": ["central-science"],
      "source": "Ch. 16.6, Table 16.2",
      "answers": [
        ["acetic acid (CH₃COOH)", "acetic acid", "acetic", "CH3COOH", "ethanoic acid"]
      ]
    }
  ]
}
```

- Each answer is a list. The first entry is what players see, and every entry is accepted.
- To add a difficulty, add an entry to `levels` and tag categories with its `id`. One category can belong to several levels.
- Each category needs at least 10 answers and a unique `prompt`. `npm test` checks both, and also catches alternates that would match two different answers.

## Deploy

See [the Render deployment steps](#deploying-on-render) below.

### Deploying on Render

1. Push this folder to a GitHub repository.
2. Go to [dashboard.render.com](https://dashboard.render.com) and choose **New → Blueprint**. Pick the repository, and Render will read `render.yaml`. Alternatively, choose **New → Web Service** and set the build command to `npm ci --omit=dev` and the start command to `npm start`.
3. Share the `https://<name>.onrender.com` URL. The lobby's room code button copies an invite link.

Notes:
- Rooms live in memory. A redeploy or restart ends any games in progress.
- On the free plan, the service sleeps after 15 minutes without traffic. The first visit after that takes about a minute to wake it.
- Run a single instance. Rooms aren't shared between instances.
