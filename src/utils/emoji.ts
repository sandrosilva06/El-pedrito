/**
 * Guardas de emoji, em codigo.
 *
 * As regras de emoji sao das que o modelo mais depressa esquece: pede-se um
 * emoji por resposta e ele poe um no fim de cada bolha, que e exatamente o
 * tique que denuncia texto automatico. O prompt continua a pedi-lo, mas quem
 * garante e isto.
 */

/** Tom de pele mulato (Fitzpatrick 4, U+1F3FD). */
const MEDIUM_SKIN_TONE = '\u{1F3FD}';

/**
 * Um emoji completo: a base, um modificador de tom ou o seletor de variacao,
 * e as continuacoes ligadas por ZWJ (familias, profissoes e afins). Sem a
 * parte do ZWJ, cortar "a mais do que um" partiria uma sequencia ao meio e
 * deixaria os pedacos soltos no texto.
 */
const EMOJI =
  /\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|️)?(?:‍\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|️)?)*/gu;

/**
 * Deixa no maximo `max` emojis na resposta INTEIRA, nao por bolha: o que se
 * quer evitar e a resposta que leva um em cada linha.
 *
 * Fica o primeiro, que e o que o modelo escolheu com mais contexto. Os
 * restantes saem, e com eles os espacos que os rodeavam.
 */
export function limitEmojis(text: string, max: number): string {
  let seen = 0;

  return (
    text
      .replace(EMOJI, (match) => {
        seen += 1;
        return seen <= max ? match : '';
      })
      // O emoji removido deixa espacos a dobrar, ou um espaco antes da
      // pontuacao. Nao se toca nas mudancas de linha: cada uma separa bolhas.
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+([,.!?:;])/g, '$1')
      .replace(/[ \t]+$/gm, '')
      .trim()
  );
}

/**
 * Poe tom de pele mulato em todos os emojis que aceitem um (maos, gestos,
 * pessoas). Os que nao aceitam, como 🚀 ou 🎰, ficam como estao.
 *
 * `\p{Emoji_Modifier_Base}` e precisamente o conjunto que admite modificador,
 * por isso nao ha lista a manter a mao.
 */
export function forceMediumSkinTone(text: string): string {
  return text.replace(
    /(\p{Emoji_Modifier_Base})(\p{Emoji_Modifier}|️)?/gu,
    // O seletor de variacao sai: o modificador de tom ja implica apresentacao
    // de emoji, e "✌️\u{1F3FD}" nao e uma sequencia valida.
    (_match, base: string) => `${base}${MEDIUM_SKIN_TONE}`,
  );
}
