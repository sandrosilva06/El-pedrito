/**
 * Le na resposta do lead se ele ja aposta ou se esta a comecar.
 *
 * Existe pela mesma razao do detector de cantao: a regra de "nao voltar a
 * perguntar" nao pode depender de o modelo se lembrar do que leu no historico.
 * O que fica guardado e o que trava a pergunta, e isso tem de ser lido em
 * codigo a partir do que o lead escreveu.
 */

export type BettingExperience = 'experiente' | 'iniciante';

/** Tira acentos e pontuacao, para "ja joguei" e "já, joguei" baterem igual. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A negacao vem primeiro: "nunca apostei" contem "apostei", e testar o lado
 * experiente antes classificaria ao contrario quem disse que nunca jogou.
 */
const INICIANTE = [
  'nunca apostei',
  'nunca joguei',
  'nunca fiz',
  'nunca experimentei',
  'nunca tinha',
  'nao aposto',
  'nao costumo apostar',
  'nao costumo jogar',
  'nao percebo nada',
  'nao percebo muito',
  'nao entendo nada',
  'sou novo nisto',
  'sou novato',
  'sou iniciante',
  'primeira vez',
  'a comecar agora',
  'estou a comecar',
  'to a comecar',
  'tou a comecar',
  'comecar do zero',
  'zero experiencia',
  'sem experiencia',
  'e a primeira',
];

const EXPERIENTE = [
  'ja apostei',
  'ja aposto',
  'ja joguei',
  'ja jogo',
  'costumo apostar',
  'costumo jogar',
  'aposto sempre',
  'aposto as vezes',
  'jogo as vezes',
  'jogo sempre',
  'ja tenho conta',
  'ja fiz apostas',
  'tenho experiencia',
  'ha uns anos',
  'ja percebo',
  'percebo disso',
  'percebo do assunto',
  'sim ja',
  'ja sim',
  'aposto ha',
  'jogo ha',
  'sou apostador',
];

function matches(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

export function detectBettingExperience(text: string): BettingExperience | null {
  if (!text) return null;

  const haystack = normalise(text);

  if (matches(haystack, INICIANTE)) return 'iniciante';
  if (matches(haystack, EXPERIENTE)) return 'experiente';

  return null;
}
