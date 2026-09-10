/**
 * Deteccao do cantao a partir do que o lead escreve.
 *
 * O estrategista tambem devolve este dado, mas um modelo falha de vez em
 * quando e o resultado dessa falha e o bot voltar a perguntar onde a pessoa
 * mora — que e exatamente o que faz uma conversa parecer um formulario. Uma
 * tabela resolve isto sem depender de ninguem.
 */

/** Cantao canonico -> formas por que o lead lhe pode chamar. */
const CANTONS: Record<string, string[]> = {
  Zurique: ['zurique', 'zurich', 'zürich', 'zuerich', 'winterthur'],
  Genebra: ['genebra', 'geneve', 'genève', 'geneva', 'genf'],
  Vaud: ['vaud', 'lausanne', 'montreux', 'vevey', 'nyon', 'yverdon'],
  Berna: ['berna', 'bern', 'berne', 'thun', 'biel', 'bienne', 'interlaken'],
  Basileia: ['basileia', 'basel', 'bale', 'bâle', 'basileia-cidade', 'baselland'],
  Lucerna: ['lucerna', 'luzern', 'lucerne'],
  Ticino: ['ticino', 'tessino', 'lugano', 'locarno', 'bellinzona'],
  'St. Gallen': ['st gallen', 'st. gallen', 'sao galo', 'são galo', 'sankt gallen'],
  Argovia: ['argovia', 'aargau', 'aarau', 'baden'],
  Friburgo: ['friburgo', 'fribourg', 'freiburg', 'bulle'],
  Valais: ['valais', 'wallis', 'sion', 'martigny', 'monthey', 'sierre'],
  Neuchatel: ['neuchatel', 'neuchâtel', 'neuenburg', 'la chaux-de-fonds'],
  Solothurn: ['solothurn', 'soleura', 'soleure', 'olten'],
  Turgovia: ['turgovia', 'thurgau', 'frauenfeld', 'kreuzlingen'],
  Zug: ['zug', 'zoug', 'zuga'],
  Schwyz: ['schwyz', 'schwytz', 'einsiedeln'],
  Grisoes: ['grisoes', 'grisões', 'graubunden', 'graubünden', 'chur', 'coira', 'davos'],
  Jura: ['jura', 'delemont', 'delémont', 'porrentruy'],
  Glarus: ['glarus', 'glaris'],
  Appenzell: ['appenzell', 'herisau'],
  Nidwalden: ['nidwalden', 'stans'],
  Obwalden: ['obwalden', 'sarnen'],
  Uri: ['uri', 'altdorf'],
  Schaffhausen: ['schaffhausen', 'schaffhouse', 'esquafusa'],
};

/** Remove acentos para "Genève" e "Geneve" caírem no mesmo sitio. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/**
 * Devolve o cantao mencionado no texto, ou null.
 *
 * Compara com limites de palavra: sem isso, "uri" apanharia "Zurique" e
 * "seguro", e o lead ficava registado no cantao errado.
 */
export function detectCanton(text: string): string | null {
  const haystack = normalise(text);

  for (const [canonical, aliases] of Object.entries(CANTONS)) {
    for (const alias of aliases) {
      const pattern = new RegExp(`(^|[^a-z0-9])${normalise(alias).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`);
      if (pattern.test(haystack)) return canonical;
    }
  }

  return null;
}
