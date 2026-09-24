/**
 * O que a legenda de uma imagem quer dizer.
 *
 * Uma imagem sozinha nao diz nada: pode ser o comprovativo do deposito, pode
 * ser o print de um erro a tentar registar. Ja aconteceu o bot agradecer um
 * "deposito" que era um print de erro, e o lead bloqueou — com razao.
 *
 * Quem decide sao as PALAVRAS do lead:
 *   "FEITO"            -> comprovativo, vai para validacao
 *   uma queixa         -> e um problema, e ajuda-se
 *   mais nada          -> nao se adivinha: espera por uma pessoa
 */

export type SentidoDaImagem = 'comprovativo' | 'problema' | 'indefinido';

/**
 * Palavras que so aparecem quando alguem esta a pedir ajuda.
 *
 * A lista e curta de proposito: cada entrada tem de ser inequivoca. Uma
 * palavra ambigua aqui faz o bot responder a um comprovativo como se fosse um
 * erro, que e o mesmo estrago ao contrario.
 */
const QUEIXAS = [
  'erro', 'error', 'nao consigo', 'não consigo', 'nao estou a conseguir',
  'não estou a conseguir', 'nao da', 'não dá', 'nao abre', 'não abre',
  'nao funciona', 'não funciona', 'nao deixa', 'não deixa', 'problema',
  'ajuda', 'bloqueado', 'recusou', 'recusado', 'falhou', 'nao carrega',
  'não carrega', 'nao aceita', 'não aceita',
];

/** "FEITO" isolado, em qualquer caixa, com ou sem pontuacao a volta. */
function temFeito(texto: string): boolean {
  return /(^|\s|[.,!;:])feito($|\s|[.,!;:])/i.test(texto);
}

export function sentidoDaImagem(legenda: string | null | undefined): SentidoDaImagem {
  const texto = (legenda ?? '').trim();

  if (texto.length === 0) return 'indefinido';

  const minusculas = texto.toLowerCase();

  // A queixa ganha ao "feito". Alguem que escreva "ja fiz mas da erro" esta a
  // pedir ajuda, nao a mandar um comprovativo — e tratar isso como deposito
  // valido e o pior dos dois enganos.
  if (QUEIXAS.some((q) => minusculas.includes(q))) return 'problema';

  if (temFeito(texto)) return 'comprovativo';

  return 'indefinido';
}
