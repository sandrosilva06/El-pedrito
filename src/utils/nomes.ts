/**
 * Como chamar o lead.
 *
 * O Telegram da um "first_name" que tanto pode ser "Mário" como "xx_sniper_xx"
 * como "5521998". Tratar um lead por "xx_sniper_xx" e tao mau como perguntar
 * o nome a quem ja o tem escrito no perfil — as duas coisas denunciam que do
 * outro lado ninguem esta a olhar.
 *
 * As tres regras pedidas:
 *   - nome proprio           -> trata-o por ele
 *   - nome proprio + numeros -> tira os numeros e trata-o pelo nome
 *   - alcunha ou so numeros  -> pergunta o nome, uma vez
 *
 * Isto vive em codigo e nao no prompt porque e uma decisao de sim ou nao que
 * tem de dar sempre o mesmo resultado. Um modelo a decidir isto acerta quase
 * sempre, e o "quase" aqui e chamar "Sniper" a uma pessoa.
 */

/** Alcunhas e palavras que aparecem em perfis e nao sao nomes de ninguem. */
const NAO_E_NOME = new Set([
  'admin', 'user', 'telegram', 'sniper', 'king', 'boss', 'master', 'pro',
  'vip', 'bet', 'bets', 'betting', 'trader', 'money', 'cash', 'rich',
  'ghost', 'dark', 'red', 'blue', 'black', 'white', 'gamer', 'player',
  'null', 'none', 'anonimo', 'anonymous', 'eu', 'me',
]);

export interface Tratamento {
  /** O nome a usar, ou null se nao houver nenhum de jeito. */
  nome: string | null;
  /** Ha que perguntar o nome? */
  perguntar: boolean;
}

/**
 * Decide como tratar o lead a partir do que o Telegram deu.
 *
 * Recebe o first_name e o username porque um pode prestar quando o outro nao
 * presta: ha quem tenha o perfil como "..." e o username como "@mario_silva".
 */
export function comoTratar(
  firstName: string | null | undefined,
  username?: string | null,
): Tratamento {
  const doNome = extrairNome(firstName);
  if (doNome) return { nome: doNome, perguntar: false };

  const doUsername = extrairNome(username);
  if (doUsername) return { nome: doUsername, perguntar: false };

  return { nome: null, perguntar: true };
}

/**
 * Tira um nome de pessoa de um campo do Telegram, ou devolve null.
 *
 * Aceita "Mario", "mario71717" e "mario_silva"; recusa "71717", "xxsniperxx" e
 * "m".
 */
export function extrairNome(valor: string | null | undefined): string | null {
  if (!valor) return null;

  // O primeiro pedaco chega: "Mário Silva" trata-se por "Mário", e um
  // apelido no cumprimento soa a carta do banco.
  const primeiro = valor.trim().split(/[\s_.\-]+/)[0] ?? '';

  // Fora os numeros do fim ("mario71717" -> "mario"). So do FIM: um numero ao
  // principio ("7mario") e alcunha, nao e nome com sufixo.
  const semNumeros = primeiro.replace(/\d+$/, '');

  if (!ehNomeDePessoa(semNumeros)) return null;

  return capitalizar(semNumeros);
}

/**
 * Parece nome de pessoa?
 *
 * Nao ha forma de ter a certeza sem uma lista de nomes do mundo inteiro, e nao
 * e isso que isto precisa: precisa de nao tratar ninguem por uma alcunha. Na
 * duvida devolve false, e o pior que acontece e perguntar o nome a alguem que
 * ja o tinha no perfil — chato, mas muito menos do que o contrario.
 */
function ehNomeDePessoa(valor: string): boolean {
  if (valor.length < 2 || valor.length > 20) return false;

  // So letras (com acentos e apostrofes, que ha nomes com eles).
  if (!/^[\p{L}][\p{L}'’]*$/u.test(valor)) return false;

  const minusculas = valor.toLowerCase();

  // Procurado como SUBSTRING e nao por igualdade: "xxsniperxx" e "betking"
  // passavam na comparacao exacta e o lead era tratado por "Xxsniperxx".
  for (const alcunha of NAO_E_NOME) {
    if (alcunha.length >= 3 && minusculas.includes(alcunha)) return false;
  }

  // "xx...xx", "zz...", e afins: duas consoantes iguais a abrir nao acontecem
  // em nomes portugueses e sao a marca das alcunhas.
  if (/^([bcdfghjklmnpqrstvwxz])\1/i.test(valor)) return false;

  // Sem vogais nao e nome de pessoa, e uma alcunha ("xyz", "kkk").
  if (!/[aeiouáàâãéêíóôõúü]/i.test(valor)) return false;

  // Tres ou mais letras iguais seguidas: "aaaa", "jooooao".
  if (/(.)\1{2,}/i.test(valor)) return false;

  return true;
}

function capitalizar(valor: string): string {
  return valor.charAt(0).toUpperCase() + valor.slice(1).toLowerCase();
}
