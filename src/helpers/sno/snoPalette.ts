/**
 * Built-in SNO palette `cyberspace-neon-256` (DECK-0003 Appendix C, normative).
 *
 * Transcribed from the Quartz reference implementation (SnoBuiltInPalette.kt),
 * which itself transcribes `decks/sno-palette.json` in the cyberspace
 * repository ("built": "2026-09-16").
 *
 * Index layout:
 * - 0..191   24 hues of 8 steps; hue h step s is h * 8 + s, step 0 darkest.
 * - 192..223 32 steels, black to white, faintly cyan.
 * - 224..255 32 signatures: instrument colours, gamut corners, neon staples,
 *            deep grounds.
 */

const HEX =
  '003632004d49006562007e7d00979900b2b800cdd700e8f9' + // 0
  '003538004c5100636d007c8a0095a900afca00c9ed6fdfff' + // 8
  '00343f004a5a0061780079980092ba00abdf34c4ff93d8ff' + // 16
  '003346004865005e860075ab008dd200a4fd6ebcffa7d3ff' + // 24
  '00305200447600589e006ccc017fff5a9bff8bb5ffb5ceff' + // 32
  '00266d002cac1902ff374fff5a73ff7e92ffa1aeffc3c9ff' + // 40
  '2200883700b75000e76837ff8064ff9b86ffb6a5ffd0c4ff' + // 48
  '3500794f00a36b00cd8b00f8a24bffb875ffcd9affe1bcff' + // 56
  '4200695f008d7f00b1a200d5c600f8dd53ffed84fff9afff' + // 64
  '4b00586b00768e0094b200b1d900cdff1ae7ff7de2ffb1e6' + // 72
  '52004674005f980077be008ee600a4ff45b4ff87c0ffb5d2' + // 80
  '5700357a00489f005ac6006bee007bff538dff8ca6ffb7c2' + // 88
  '5a00247e0031a3003dcb0047f4004eff5b6aff908effb9b4' + // 96
  '5c0010800014a60013ce0006f22400ff613eff9375ffbba5' + // 104
  '561200752200943300b44600d45a00f47000ff9652ffbd93' + // 112
  '4b1f00683100854300a25700c06d00de8300fc9b00ffc077' + // 120
  '4426005e3800794c00946100b07800cc8f00e7a800ffc333' + // 128
  '3e2a00563d006e5300876900a08100b99900d2b300ebce00' + // 136
  '372d004d42006358007970008f8800a5a300b9be00cdda00' + // 144
  '2f3000424600555e0067770077910087ad0094ca009fe800' + // 152
  '243400314b003d6400457f00499b0045b9002cd90000f837' + // 160
  '073900005108006a1f008436009f4e00ba6700d68200f39e' + // 168
  '00381e00503000684400825b009c7300b78d00d3a900efc6' + // 176
  '00372a004e3f00665600806e009a8900b4a500d0c200ece1' + // 184
  '010101020203050606090b0c0f121315191a1b2021222728' + // 192
  '282e302f3638373e403e4648454e504d5658555e605d6769' + // 200
  '666f716e787a77808380898c899294939b9d9ca4a6a6adaf' + // 208
  'b0b6b8babfc1c4c9caced2d3d8dcdce3e5e6eeefeff8f8f8' + // 216
  '000000ffffff00e5ffff3b6bf7931a52e39fc8f5ff6f8ea0' + // 224
  '1d354705070dff00ff00ff0000ffffffff00ff00000000ff' + // 232
  '39ff14ff6ec77df9ffb026fffffb00ff330000ff9fff007f' + // 240
  '4d4dffffd3000a0f1a12182a1a0f240f1f1c2410161c1c0f'; // 248

/** 256 colours as `[r, g, b]` 0..255 triples, index-aligned with Appendix C. */
export const SNO_BUILT_IN_PALETTE: [number, number, number][] = Array.from(
  { length: 256 },
  (_, i): [number, number, number] => {
    const at = i * 6;
    return [
      parseInt(HEX.slice(at, at + 2), 16),
      parseInt(HEX.slice(at + 2, at + 4), 16),
      parseInt(HEX.slice(at + 4, at + 6), 16),
    ];
  }
);

/** The registered name of the built-in palette — the only one §1.3a defines. */
export const SNO_BUILT_IN_PALETTE_NAME = 'cyberspace-neon-256';
