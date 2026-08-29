/**
 * Pixel whale-girl frames for the maid persona easter egg: the 48x24
 * quadrant-block icon (whale_maid_fixed_clean_48x24) re-quantized into this
 * package's sprite alphabet at the header's 13-row height - 40 columns x 26
 * sprite rows, majority-vote downsampling from the 96x48 subpixel raster.
 *
 * Provenance & license: original pixel piece authored for this project
 * (Adam, 2026-08) — the 48x20 wide variant was resampled to 48x24 (centered
 * nearest-neighbour, see RESET_NOTES) before re-quantization. Not
 * third-party artwork; no THIRD_PARTY_LICENSES entry required.
 * Own palette alphabet (rendered through the shared half-block renderer):
 * K deep-navy outline - 1/2/3 blues (hair/body) - W white (apron) -
 * P pink (ribbon/blush) - S skin - `.` transparent.
 */

import type { WhaleFrame } from './whaleFrames.js'

/** Maid palette: letter -> true-color RGB (see the file comment). */
export const MAID_PALETTE: Record<string, readonly [number, number, number] | undefined> = {
  K: [13, 11, 55],
  '1': [46, 58, 126],
  '2': [77, 96, 175],
  '3': [128, 141, 182],
  W: [254, 253, 253],
  P: [220, 197, 198],
  S: [248, 233, 225],
}

/** The maid's static settled pose (one frame for now). */
export const WHALE_MAID_FRAMES: readonly WhaleFrame[] = [
  {
    name: 'standard',
    rows: [
      '...........WKK..........................',
      '.........KKK222.........................',
      '........KK22322W........................',
      '.......22...KK.23WW3KK..................',
      '..........KKWWWWWWWW3WWKK...............',
      '.........KKWWWWWWWWPWWWKKK..............',
      '.......WWWWW312222221PWWWP3.............',
      '.......WWW1122222222211WW3WW............',
      '.......S12222222222223331WWWK...........',
      '.....KKK2222222222222333KWWWKK..........',
      '.....KK22211222222122222KKPPK2S.........',
      '.....K222212222222P122222W33KK..........',
      '...SS22222P2222222PS22222KKKKK1.........',
      '..K1122222SS222222SKS2222221111KK.......',
      'KK11122221KKK2222KKKKKK2221111111K......',
      'K1111222KKSKKSS2SSS12KK22211P1111K......',
      '....31122PS23SSSSSW12W2222111PSK........',
      '......1222PPSSSSSSSSS212212211..........',
      '......12211SSSSPSSSSS112212221........KK',
      '...KK12121111111PPS11222111222..K....K11',
      '..KWSSK211WWWKKWPPWW222WW111221.K11KK211',
      '..KSSSW111WWK11KK11KW2WWW111221.K11K122.',
      '...PSPWKK1WPK11PP11KW22WPK12221..K1111K.',
      '.K1SWWWP1K33WK1WW11WW1WW111121111.K11K..',
      '.K11WS11K11WWWWWWWWWW1111111K2111K112K..',
      '..K11111K1KPPPKSSSPWPKKSSS1K22111112K...',
    ],
  },
]
