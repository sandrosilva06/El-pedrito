/**
 * O que o lead disse sobre a conta na casa de que estao a falar.
 *
 * Existe por causa de uma conversa real. O funil mandou o link da Plan Bet, o
 * lead respondeu TRES vezes "Ja tenho conta", e das tres o sistema leu aquilo
 * como registo feito e empurrou o deposito. Ele desistiu.
 *
 * "Ja tenho conta" quer dizer duas coisas opostas, e a diferenca e a conversao
 * inteira:
 *
 * - ja tinha, de antes  -> nao ha comissao de registo -> TEM de mudar de casa
 * - criei agora, pelo teu link -> isto E a conversao  -> segue para o deposito
 *
 * Por isso a leitura tem tres resultados e nao dois. O terceiro, `ambiguo`, e o
 * mais importante de todos: e a frase dita sem dizer de quando, e a resposta
 * certa a ela nao e escolher um dos lados — e perguntar. Adivinhar foi o erro.
 *
 * Em codigo e nao so no prompt porque isto decide dinheiro. Uma regra de prompt
 * e uma sugestao forte: o modelo cumpre-a quase sempre, e o "quase" e uma
 * mensagem ja enviada a um lead.
 */

/** Acentos fora, pontuacao a espaco. O mesmo molde do `experience.ts`. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type ClaimDeConta = 'criou' | 'ja_tinha' | 'ambiguo' | 'nao_tem';

/** Ele diz que NAO tem conta la. O caminho limpo: segue por esta casa. */
const NAO_TEM = [
  'nao tenho conta',
  'nao tenho la conta',
  'nao tenho nenhuma conta',
  'nunca fiz conta',
  'nunca tive conta',
  'ainda nao tenho conta',
  'ainda nao criei',
  'nao estou registado',
  'nunca me registei',
];

/** Ele diz que a criou AGORA, pelo nosso link. Isto e a conversao. */
const CRIOU = [
  'acabei de criar',
  'acabei de fazer',
  'acabei de me registar',
  'criei agora',
  'criei a conta agora',
  'ja criei a conta',
  'ja criei',
  'ja me registei',
  'registei me',
  'acabei de abrir',
  'abri a conta agora',
  'fiz o registo',
  'ja fiz o registo',
  'conta criada',
  'criei pelo teu link',
  'criei pelo link',
  'fiz pelo teu link',
];

/** Ele diz que a conta e ANTIGA. Nao ha registo: muda-se de casa. */
const JA_TINHA = [
  'ja tinha conta',
  'ja tinha essa',
  'ja tinha la conta',
  'ja tinha feito',
  'ja tinha essa conta',
  'conta antiga',
  'de antes',
  'ha muito tempo',
  'ja jogava nessa',
  'ja jogava la',
  'tenho conta ha',
  'tenho essa ha',
  'ja era registado',
  'ja estava registado',
];

/**
 * A frase do lead sem dizer de quando. NAO decide nada — pede uma pergunta.
 *
 * E literalmente o que o Ruben escreveu, tres vezes.
 */
const AMBIGUO = [
  'ja tenho conta',
  'ja tenho essa conta',
  'ja tenho la conta',
  'tenho conta nessa',
  'tenho conta la',
  'tenho conta ai',
  'tenho conta nessa casa',
  'ja tenho',
];

function bate(texto: string, agulhas: readonly string[]): boolean {
  return agulhas.some((agulha) => texto.includes(agulha));
}

/**
 * O que ele disse, ou null quando nao falou do assunto.
 *
 * A ORDEM DAS PERGUNTAS E A ARMADILHA, e e a mesma licao do `experience.ts`,
 * onde o INICIANTE tem de ser testado antes do EXPERIENTE. Aqui:
 *
 * - `nao tenho conta` contem `tenho conta`, logo teria de cair em `ambiguo`;
 * - `ja tinha conta de antes` nao contem `ja tenho conta`, mas `ja tenho` e
 *   subcadeia de varias frases proximas;
 * - `ja tenho conta, criei agora` tem as duas coisas, e a que manda e a que diz
 *   QUANDO.
 *
 * Por isso: primeiro a negacao, depois as duas que datam a conta, e o `ambiguo`
 * no fim, como rede. Trocar esta ordem parte o caso real.
 */
export function lerClaimDeConta(texto: string): ClaimDeConta | null {
  if (!texto) return null;

  const t = normalise(texto);

  if (bate(t, NAO_TEM)) return 'nao_tem';
  if (bate(t, CRIOU)) return 'criou';
  if (bate(t, JA_TINHA)) return 'ja_tinha';
  if (bate(t, AMBIGUO)) return 'ambiguo';

  return null;
}
