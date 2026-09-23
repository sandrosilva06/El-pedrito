/**
 * Entrar na conta do El Pedrito, uma vez, e guardar a sessao.
 *
 * CORRE ISTO NO TEU COMPUTADOR, nao no Render: pede o codigo que o Telegram
 * manda por SMS ou para outra sessao, e isso e interactivo. O que sai daqui e
 * uma linha de texto que se cola na variavel USERBOT_SESSION da plataforma.
 *
 *   TELEGRAM_API_ID=... TELEGRAM_API_HASH=... npx tsx src/scripts/login-userbot.ts
 *
 * O api_id e o api_hash tiram-se de https://my.telegram.org, em "API
 * development tools". Sao teus e servem para sempre.
 *
 * A SESSAO VALE TANTO COMO A CONTA.
 * Quem tiver aquela linha entra no Telegram como tu: le as conversas todas,
 * escreve a quem quiser, e nao precisa do teu telemovel para nada. Nunca a
 * metas no repositorio nem num print. Se alguma vez escapar, vai a Telegram,
 * Definicoes, Dispositivos, e termina as outras sessoes — isso invalida-a na
 * hora.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

async function main(): Promise<void> {
  const apiId = Number(process.env.TELEGRAM_API_ID ?? 0);
  const apiHash = process.env.TELEGRAM_API_HASH ?? '';

  if (!apiId || !apiHash) {
    console.error(
      'Faltam credenciais.\n\n' +
        'Vai a https://my.telegram.org -> API development tools, cria uma app,\n' +
        'e corre outra vez assim:\n\n' +
        '  TELEGRAM_API_ID=1234567 TELEGRAM_API_HASH=abc... npx tsx src/scripts/login-userbot.ts\n',
    );
    process.exit(1);
  }

  const { TelegramClient } = await import('teleproto');
  const { StringSession } = await import('teleproto/sessions');

  const rl = createInterface({ input: stdin, output: stdout });
  const perguntar = (texto: string) => rl.question(texto);

  const cliente = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 5,
  });

  console.log('\nVamos entrar na conta do El Pedrito.\n');

  await cliente.start({
    phoneNumber: () => perguntar('Numero de telemovel (com indicativo, ex. +41...): '),
    phoneCode: () => perguntar('Codigo que o Telegram enviou: '),
    // Se a conta tiver verificacao em dois passos. Sem 2FA isto nunca e
    // chamado; com 2FA, sem isto o login falhava sem explicar porque.
    password: () => perguntar('Palavra-passe da verificacao em dois passos: '),
    onError: (erro) => {
      console.error('Erro no login:', erro);
    },
  });

  const eu = await cliente.getMe();
  const sessao = String(cliente.session.save());

  console.log(
    `\nEntrou como ${eu?.firstName ?? ''}${eu?.username ? ` (@${eu.username})` : ''}.\n`,
  );
  console.log('Poe estas variaveis no Render (Environment) e faz deploy:\n');
  console.log(`  USERBOT_ENABLED=true`);
  console.log(`  TELEGRAM_API_ID=${apiId}`);
  console.log(`  TELEGRAM_API_HASH=${apiHash}`);
  console.log(`  USERBOT_SESSION=${sessao}`);
  console.log(
    '\nA ultima linha vale tanto como a conta: nao a mostres a ninguem nem a\n' +
      'guardes no repositorio. Para a invalidar, termina a sessao em\n' +
      'Telegram > Definicoes > Dispositivos.\n',
  );

  rl.close();
  await cliente.disconnect();
  process.exit(0);
}

void main();
