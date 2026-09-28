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
  // NAO acrescentes aqui "ja tenho conta" solto. Esteve nesta lista e custou-nos
  // um lead: dito assim, sem dizer ONDE, nao fala de saber apostar — fala de ter
  // conta na casa de que estamos a falar, e e a frase com que ele trava o funil
  // quando o link que levou e de uma casa onde ja esta registado. Lida como
  // experiencia, a objecao virava "o lead JA TE DISSE que ja aposta" dentro do
  // prompt: mais uma razao para o funil seguir em frente. Ele disse-o tres
  // vezes. Quando ele NOMEIA a casa ("ja tenho conta na Betano") ai sim e
  // experiencia, e disso trata o CASA_NOMEADA la em baixo.
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

/**
 * As duas palavras canonicas, que nenhuma das listas acima tinha.
 *
 * Isto e lido em dois sitios com origens diferentes: a mensagem CRUA do lead,
 * que traz frases de conversa ("ja aposto ha anos"), e o campo
 * `bettingExperience` da diretriz, onde o schema pede ao modelo exactamente
 * "experiente" ou "iniciante". Sem estas duas entradas, a resposta do modelo
 * nao casava com lista nenhuma e era deitada fora em silencio — a pergunta da
 * experiencia so ficava gravada quando o lead calhava de usar uma das frases.
 */
const CANONICO: Record<string, BettingExperience> = {
  experiente: 'experiente',
  iniciante: 'iniciante',
};

/**
 * "Ja tenho conta NA BETANO" — com a casa nomeada.
 *
 * E a fronteira entre um facto e uma objecao, e esta em codigo porque a
 * diferenca sao duas letras. Nomear uma casa onde ja joga diz mesmo que ele
 * aposta. "Ja tenho conta", "ja tenho conta nessa casa", "ja tenho conta la" —
 * sem nome — nao dizem nada sobre apostar: dizem que o link que lhe demos nao
 * serve. Essa fica sem classificacao, de proposito, para nao virar um facto
 * que o prompt depois usa contra ele.
 */
const CASA_NOMEADA = /\bja tenho conta n[ao] [a-z]{3,}/;

export function detectBettingExperience(text: string): BettingExperience | null {
  if (!text) return null;

  const haystack = normalise(text);

  // A palavra exacta primeiro: quando o texto E so "experiente", veio do modelo
  // e nao ha nada para interpretar. As listas de frases so entram depois, para
  // a mensagem crua do lead.
  const exacto = CANONICO[haystack.trim()];
  if (exacto) return exacto;

  if (matches(haystack, INICIANTE)) return 'iniciante';
  if (matches(haystack, EXPERIENTE)) return 'experiente';
  if (CASA_NOMEADA.test(haystack)) return 'experiente';

  return null;
}
