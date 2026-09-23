/**
 * Entrar na conta do El Pedrito a partir do browser.
 *
 * PORQUE E QUE ISTO EXISTE
 * O login do MTProto e interactivo: o Telegram manda um codigo para o
 * telemovel e so o aceita de volta na mesma ligacao que o pediu. O caminho
 * normal e um script de terminal — e isso obriga a instalar o Node, clonar o
 * repositorio e saber usar a linha de comandos, so para uma coisa que se faz
 * uma vez na vida.
 *
 * O servico no Render ja tem tudo: rede para os servidores do Telegram, as
 * credenciais da app, e uma pagina de administracao protegida por
 * palavra-passe. Falta-lhe so o codigo, que so o dono do telemovel tem. Entao
 * o login passa a ser: escrever o numero na pagina, receber o codigo no
 * telemovel, escreve-lo na pagina.
 *
 * A LIGACAO TEM DE SOBREVIVER ENTRE OS DOIS PEDIDOS
 * O phone_code_hash so vale na ligacao que o pediu, e uma ligacao MTProto nao
 * se guarda num cookie. Por isso o cliente fica em memoria entre o "manda o
 * codigo" e o "aqui esta o codigo", com prazo para morrer se ninguem acabar o
 * que comecou.
 *
 * O QUE SAI DAQUI VALE TANTO COMO A CONTA.
 * A sessao e mostrada UMA vez, para ser colada nas variaveis do Render, e e
 * tambem guardada na base de dados para o servico a poder usar ja. Nunca vai
 * para o log: um log de plataforma e lido por mais gente do que se pensa.
 */
import { gravarMeta, lerMeta } from '../db/database';
import { env } from '../config/env';
import { createLogger } from '../utils/logger';

const log = createLogger('userbot-login');

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Onde a sessao fica guardada quando o login e feito pela pagina. */
export const CHAVE_SESSAO = 'userbot_session';

/** Um login a meio: a ligacao viva e o que o Telegram devolveu. */
interface LoginPendente {
  cliente: any;
  telefone: string;
  phoneCodeHash: string;
  criadoEm: number;
}

/**
 * So um login de cada vez. Nao ha aqui concorrencia nenhuma a servir: e uma
 * pessoa, uma vez, e ter varios pendentes so daria ligacoes esquecidas abertas
 * contra o Telegram.
 */
let pendente: LoginPendente | null = null;

/** Cinco minutos chegam para ir buscar o codigo ao telemovel. */
const PRAZO_MS = 5 * 60 * 1000;

function expirou(p: LoginPendente): boolean {
  return Date.now() - p.criadoEm > PRAZO_MS;
}

async function largarPendente(): Promise<void> {
  if (!pendente) return;

  const { cliente } = pendente;
  pendente = null;

  try {
    await cliente.disconnect();
  } catch {
    // Uma ligacao que nao fecha bem nao pode impedir o login seguinte.
  }
}

export interface ResultadoCodigo {
  estado: 'codigo-enviado';
  /** Como o Telegram o mandou, para a pagina poder dizer onde procurar. */
  porOnde: string;
}

/**
 * Pede o codigo ao Telegram.
 *
 * Devolve por onde e que o codigo vai — a app, SMS ou chamada. Isso importa
 * mais do que parece: quem tem o Telegram noutro dispositivo recebe o codigo
 * LA e nao por SMS, e fica a olhar para as mensagens a espera de nada.
 */
export async function pedirCodigo(telefone: string): Promise<ResultadoCodigo> {
  if (!env.TELEGRAM_API_ID || !env.TELEGRAM_API_HASH) {
    throw new Error('faltam TELEGRAM_API_ID e TELEGRAM_API_HASH nas variaveis do servico');
  }

  const limpo = telefone.replace(/[^\d+]/g, '');

  if (!/^\+?\d{8,15}$/.test(limpo)) {
    throw new Error('numero invalido: escreve com indicativo, por exemplo +41761234567');
  }

  await largarPendente();

  const { TelegramClient } = await import('teleproto');
  const { StringSession } = await import('teleproto/sessions');

  const cliente = new TelegramClient(
    new StringSession(''),
    env.TELEGRAM_API_ID,
    env.TELEGRAM_API_HASH,
    { connectionRetries: 3 },
  );

  await cliente.connect();

  const { phoneCodeHash, isCodeViaApp } = await cliente.sendCode(
    { apiId: env.TELEGRAM_API_ID, apiHash: env.TELEGRAM_API_HASH },
    limpo,
  );

  pendente = { cliente, telefone: limpo, phoneCodeHash, criadoEm: Date.now() };

  log.info(`codigo pedido para ${mascarar(limpo)} (${isCodeViaApp ? 'app' : 'SMS'})`);

  return {
    estado: 'codigo-enviado',
    porOnde: isCodeViaApp ? 'app' : 'sms',
  };
}

export type ResultadoLogin =
  | { estado: 'entrou'; sessao: string; nome: string }
  | { estado: 'precisa-password' };

/**
 * Entrega o codigo ao Telegram e, se chegar, guarda a sessao.
 *
 * A conta com verificacao em dois passos nao entra aqui: o Telegram responde
 * SESSION_PASSWORD_NEEDED e o passo seguinte e a palavra-passe.
 */
export async function confirmarCodigo(codigo: string): Promise<ResultadoLogin> {
  const p = exigirPendente();

  const { Api } = await import('teleproto');

  try {
    await p.cliente.invoke(
      new Api.auth.SignIn({
        phoneNumber: p.telefone,
        phoneCodeHash: p.phoneCodeHash,
        phoneCode: codigo.replace(/\D/g, ''),
      }),
    );
  } catch (error) {
    const mensagem = String((error as Error)?.message ?? error);

    if (mensagem.includes('SESSION_PASSWORD_NEEDED')) {
      return { estado: 'precisa-password' };
    }

    throw traduzir(mensagem);
  }

  return concluir();
}

/** Segundo passo, para contas com verificacao em dois passos. */
export async function confirmarPassword(password: string): Promise<ResultadoLogin> {
  const p = exigirPendente();

  const { Api } = await import('teleproto');
  const { computeCheck } = await import('teleproto/Password');

  try {
    const info = await p.cliente.invoke(new Api.account.GetPassword());
    const prova = await computeCheck(info, password);
    await p.cliente.invoke(new Api.auth.CheckPassword({ password: prova }));
  } catch (error) {
    throw traduzir(String((error as Error)?.message ?? error));
  }

  return concluir();
}

/** Entrou: guarda a sessao e larga a ligacao temporaria. */
async function concluir(): Promise<ResultadoLogin> {
  const p = exigirPendente();

  const eu = await p.cliente.getMe();
  const sessao = String(p.cliente.session.save());

  await gravarMeta(CHAVE_SESSAO, sessao);

  const nome = eu?.username ? `@${eu.username}` : (eu?.firstName ?? 'conta');

  // O nome vai para o log, a sessao NUNCA.
  log.info(`login concluido como ${nome}; sessao guardada`);

  await largarPendente();

  return { estado: 'entrou', sessao, nome };
}

function exigirPendente(): LoginPendente {
  if (!pendente) {
    throw new Error('nao ha nenhum login a meio: comeca outra vez pelo numero');
  }

  if (expirou(pendente)) {
    void largarPendente();
    throw new Error('o codigo demorou de mais e expirou: pede outro');
  }

  return pendente;
}

/**
 * As mensagens do Telegram sao em maiusculas e nao dizem nada a quem nao as
 * conhece. Isto e o que a pagina mostra.
 */
function traduzir(mensagem: string): Error {
  if (mensagem.includes('PHONE_CODE_INVALID')) return new Error('codigo errado');
  if (mensagem.includes('PHONE_CODE_EXPIRED')) return new Error('o codigo expirou: pede outro');
  if (mensagem.includes('PASSWORD_HASH_INVALID')) return new Error('palavra-passe errada');
  if (mensagem.includes('PHONE_NUMBER_INVALID')) return new Error('numero invalido');
  if (mensagem.includes('PHONE_NUMBER_BANNED')) return new Error('esta conta esta banida do Telegram');
  if (mensagem.includes('FLOOD_WAIT')) {
    const segundos = /FLOOD_WAIT_(\d+)/.exec(mensagem)?.[1];
    return new Error(
      `o Telegram pediu para esperar${segundos ? ` ${Math.ceil(Number(segundos) / 60)} minuto(s)` : ''} antes de tentar outra vez`,
    );
  }

  return new Error(mensagem);
}

/** Esconde o meio do numero, para o log nao ficar com ele inteiro. */
function mascarar(telefone: string): string {
  return telefone.length > 6
    ? `${telefone.slice(0, 4)}***${telefone.slice(-2)}`
    : '***';
}

/**
 * A sessao guardada pela pagina, se houver.
 *
 * A variavel de ambiente GANHA: e a que sobrevive a um deploy quando a base de
 * dados nao sobrevive. Isto e o que faz o login pela pagina funcionar ja, antes
 * de a variavel estar posta.
 */
export async function sessaoGuardada(): Promise<string> {
  if (env.USERBOT_SESSION) return env.USERBOT_SESSION;

  try {
    return (await lerMeta(CHAVE_SESSAO)) ?? '';
  } catch {
    return '';
  }
}
