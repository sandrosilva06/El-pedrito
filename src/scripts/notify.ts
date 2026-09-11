/**
 * Envios pontuais a listas fixas de leads.
 *
 *   npm run notify                       # lista as campanhas
 *   npm run notify vip-link -- --dry-run  # mostra sem enviar
 *   npm run notify vip-link               # envia
 *
 * Tambem envia uma mensagem avulsa a um so lead:
 *
 *   npm run notify -- --user 7691672875 --message "oi" --dry-run
 *   npm run notify -- --user 7691672875 --message "oi"
 *
 * Em producao, onde o build ja correu, dispensa o tsx:
 *
 *   node dist/scripts/notify.js vip-link --dry-run
 *   node dist/scripts/notify.js --user 7691672875 --message "oi"
 *
 * Cada campanha e enviada uma vez so por destinatario: os envios ficam num
 * recibo em disco, com a campanha na chave. Correr o script duas vezes por
 * engano manda a mesma mensagem duas vezes a pessoas reais, e isso nao se
 * desfaz.
 */
import fs from 'node:fs';
import path from 'node:path';

import 'dotenv/config';
import { Api, GrammyError } from 'grammy';

interface Target {
  chatId: number;
  name: string;
}

interface Campaign {
  id: string;
  description: string;
  message: string;
  targets: Target[];
  /** Mostrar a pre-visualizacao do link. Util para convites de grupo. */
  linkPreview?: boolean;
}

const LEADS_VALIDADOS: Target[] = [
  { chatId: 1222882479, name: 'Gilberto' },
  { chatId: 558645729, name: 'Diogo' },
  { chatId: 8419987514, name: 'Marcelino' },
];

const CAMPAIGNS: Campaign[] = [
  {
    id: 'ftd-validacao',
    description: 'Confirmacao de deposito aos leads que acabaram de depositar',
    targets: LEADS_VALIDADOS,
    message:
      'Boas mano! Já confirmei aqui o teu depósito e a tua conta está 100% validada. 🤝\n\n' +
      'Daqui a nada já te envio o link de acesso direto ao nosso grupo VIP de sinais. ' +
      'Fica atento às mensagens por aqui!',
  },
  {
    id: 'vip-link',
    description: 'Entrega do link do grupo VIP aos leads ja validados',
    targets: LEADS_VALIDADOS,
    // A pre-visualizacao fica ligada: num convite de grupo, ver o nome do
    // grupo antes de clicar e o que distingue isto de um link suspeito.
    linkPreview: true,
    message:
      'Aqui tens o teu acesso exclusivo ao nosso grupo VIP de sinais, mano! 🚀\n\n' +
      'Entra por este link: https://t.me/+aTgtTQdqcThjNTk0\n\n' +
      'Aproveita, segue a gestão de banca e qualquer dúvida manda mensagem por aqui. Tamo junto!',
  },
];

const RECEIPT_PATH = path.resolve(process.cwd(), 'data/notified.json');
const LEGACY_RECEIPT_PATH = path.resolve(process.cwd(), 'data/ftd-notified.json');

interface Receipt {
  campaign: string;
  chatId: number;
  name: string;
  sentAt: string;
  messageId: number;
}

/**
 * Le o recibo, absorvendo o formato antigo (sem campanha) que o script
 * anterior escrevia. Sem isto, quem ja recebeu a confirmacao de deposito
 * receberia-a outra vez.
 */
function loadReceipts(): Receipt[] {
  const read = (file: string): unknown[] => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown[];
    } catch {
      return [];
    }
  };

  const current = read(RECEIPT_PATH) as Receipt[];
  const legacy = (read(LEGACY_RECEIPT_PATH) as Omit<Receipt, 'campaign'>[]).map((entry) => ({
    ...entry,
    campaign: 'ftd-validacao',
  }));

  return [...legacy, ...current];
}

function appendReceipt(entry: Receipt): void {
  const current = (() => {
    try {
      return JSON.parse(fs.readFileSync(RECEIPT_PATH, 'utf8')) as Receipt[];
    } catch {
      return [];
    }
  })();

  fs.mkdirSync(path.dirname(RECEIPT_PATH), { recursive: true });
  fs.writeFileSync(RECEIPT_PATH, `${JSON.stringify([...current, entry], null, 2)}\n`);
}

function listCampaigns(): void {
  console.log('Campanhas disponiveis:\n');
  for (const campaign of CAMPAIGNS) {
    console.log(`  ${campaign.id.padEnd(16)} ${campaign.description}`);
    console.log(`  ${''.padEnd(16)} ${campaign.targets.length} destinatario(s)\n`);
  }
  console.log('Uso: npm run notify <campanha> [-- --dry-run]');
  console.log('     node dist/scripts/notify.js <campanha> [--dry-run]');
  console.log('');
  console.log('Mensagem avulsa a um lead:');
  console.log('     npm run notify -- --user <ID> --message "<TEXTO>" [--dry-run]');
}

/** Le o valor de um argumento no formato `--chave valor`. */
function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;

  const value = args[index + 1];
  // Um valor que comeca por `--` e a flag seguinte, nao o valor desta.
  return value === undefined || value.startsWith('--') ? undefined : value;
}

/**
 * Envio avulso: um destinatario, um texto vindo da linha de comandos.
 *
 * Ao contrario das campanhas, nao bloqueia repeticoes. Uma campanha e um
 * disparo unico por lista; uma mensagem escrita a mao pode legitimamente
 * repetir-se numa conversa. Fica na mesma no recibo, para haver rasto.
 */
async function sendDirect(api: Api, args: string[], dryRun: boolean): Promise<never> {
  const rawUser = readFlag(args, 'user');
  const text = readFlag(args, 'message');

  if (!rawUser) {
    console.error('Falta o --user <ID>.');
    process.exit(1);
  }

  const chatId = Number(rawUser);

  // Um ID mal escrito nao da erro: entrega a mensagem a um desconhecido.
  if (!Number.isSafeInteger(chatId)) {
    console.error(`--user "${rawUser}" nao e um ID de Telegram valido.`);
    process.exit(1);
  }

  if (!text || text.trim().length === 0) {
    console.error('Falta o --message "<TEXTO>".');
    process.exit(1);
  }

  // O Telegram rejeita acima de 4096 caracteres; melhor falhar aqui.
  if (text.length > 4096) {
    console.error(`Mensagem com ${text.length} caracteres, o limite do Telegram e 4096.`);
    process.exit(1);
  }

  console.log(`Destino:  ${chatId}`);
  console.log(`Modo:     ${dryRun ? 'DRY RUN (nao envia)' : 'ENVIO REAL'}`);
  console.log(`Texto:    ${text}\n`);

  if (dryRun) {
    console.log('  ENVIARIA  mensagem acima');
    process.exit(0);
  }

  try {
    const message = await api.sendMessage(chatId, text, {
      link_preview_options: { is_disabled: true },
    });

    appendReceipt({
      campaign: 'avulso',
      chatId,
      name: 'avulso',
      sentAt: new Date().toISOString(),
      messageId: message.message_id,
    });

    console.log(`  ENVIADO   ${chatId} — message_id ${message.message_id}`);
    console.log(`Recibo: ${RECEIPT_PATH}`);
    process.exit(0);
  } catch (error) {
    const description = error instanceof GrammyError ? error.description : String(error);
    console.error(`  FALHOU    ${chatId} — ${description}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const direct = args.includes('--user') || args.includes('--message');

  // Os valores das flags nao sao nomes de campanha: sem isto, o `123` de
  // `--user 123` passaria por campanha e o script rejeitava-o.
  const flagValues = new Set(
    ['user', 'message']
      .map((name) => readFlag(args, name))
      .filter((value): value is string => value !== undefined),
  );
  const campaignId = args.find((arg) => !arg.startsWith('--') && !flagValues.has(arg));

  if (!direct && !campaignId) {
    listCampaigns();
    process.exit(0);
  }

  const campaign = direct ? undefined : CAMPAIGNS.find((entry) => entry.id === campaignId);

  if (!direct && !campaign) {
    console.error(`Campanha "${campaignId}" nao existe.\n`);
    listCampaigns();
    process.exit(1);
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN em falta.');
    process.exit(1);
  }

  const api = new Api(token);

  // Confirma de que bot se esta a falar antes de enviar seja o que for: com
  // duas personas no repositorio, enganar-se no token manda a mensagem do
  // influencer errado.
  const me = await api.getMe();
  console.log(`Bot:      @${me.username} (${me.id})`);

  if (direct) await sendDirect(api, args, dryRun);

  // A partir daqui e sempre uma campanha: o ramo avulso acima nunca retorna.
  if (!campaign) process.exit(1);

  console.log(`Campanha: ${campaign.id} — ${campaign.description}`);
  console.log(`Modo:     ${dryRun ? 'DRY RUN (nao envia)' : 'ENVIO REAL'}\n`);

  const already = new Set(
    loadReceipts()
      .filter((entry) => entry.campaign === campaign.id)
      .map((entry) => entry.chatId),
  );

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const target of campaign.targets) {
    const label = `${target.name} (${target.chatId})`;

    if (already.has(target.chatId)) {
      console.log(`  SALTADO   ${label} — ja consta do recibo desta campanha`);
      skipped += 1;
      continue;
    }

    if (dryRun) {
      console.log(`  ENVIARIA  ${label}`);
      continue;
    }

    try {
      const message = await api.sendMessage(target.chatId, campaign.message, {
        link_preview_options: { is_disabled: campaign.linkPreview !== true },
      });

      appendReceipt({
        campaign: campaign.id,
        chatId: target.chatId,
        name: target.name,
        sentAt: new Date().toISOString(),
        messageId: message.message_id,
      });

      console.log(`  ENVIADO   ${label} — message_id ${message.message_id}`);
      sent += 1;
    } catch (error) {
      const description = error instanceof GrammyError ? error.description : String(error);
      console.error(`  FALHOU    ${label} — ${description}`);
      failed += 1;
    }

    // O Telegram limita a ~30 mensagens por segundo; com poucos destinatarios
    // sobra folga, mas o intervalo mantem-se por habito.
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  console.log(`\nEnviadas: ${sent} | Saltadas: ${skipped} | Falhadas: ${failed}`);
  if (!dryRun) console.log(`Recibo: ${RECEIPT_PATH}`);

  process.exit(failed > 0 ? 1 : 0);
}

void main();
