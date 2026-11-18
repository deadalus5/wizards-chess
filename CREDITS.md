# Credits

All third-party assets in `public/assets` are released under CC0 1.0 (public domain dedication).
No attribution is required; the creators are credited here with thanks.

| Asset | Creator | Source |
|---|---|---|
| Human animation library, reference rig | Mesh2Motion contributors (many clips retargeted from Quaternius) | https://github.com/Mesh2Motion/mesh2motion-app (commit 5d6918ef67) |
| Fantasy weapon props | Kay Lousberg (KayKit), via Mesh2Motion | https://kaylousberg.com |
| Universal Base Characters (bodies, hair) | Quaternius | https://quaternius.com/packs/universalbasecharacters.html |
| Chess Set model | Riley Queen / Poly Haven | https://polyhaven.com/a/chess_set |
| HDRIs and PBR textures | Poly Haven | https://polyhaven.com |
| Marble textures | ambientCG | https://ambientcg.com |
| Sound effects | Kenney; OpenGameArt contributors | https://kenney.nl, https://opengameart.org |

Quaternius and Kay Lousberg offer their packs free of charge and accept support on their own sites.

## Chess engine (not CC0)

The computer opponent is **Stockfish.js 19.0.1**, the "lite single-threaded" build, vendored
unmodified in `public/engine/` (`stockfish-19-lite-single.js` and `.wasm`). It is licensed under
the **GNU General Public License v3**; the licence text is `public/engine/Copying.txt`, served
beside the engine. It runs as a separate program in a Web Worker and talks to the game only
through the UCI protocol.

- Stockfish.js by Nathan Rugg / Chess.com: https://github.com/nmrugg/stockfish.js (source,
  build scripts), npm package `stockfish@19.0.1`
- Stockfish by T. Romstad, M. Costalba, J. Kiiski, G. Linscott and the Stockfish contributors:
  https://github.com/official-stockfish/Stockfish
- Lite network by Chris Bao (sscg13)
