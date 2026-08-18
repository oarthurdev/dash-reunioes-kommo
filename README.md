# Placar de Reuniões — Kommo CRM

Dashboard administrativo em tempo real que recebe webhooks de alteração de status de lead da Kommo CRM e mostra um **ranking de reuniões por corretor** (pódio top 3 + lista com todos os corretores da conta), com filtro Hoje / 7 dias / 30 dias. Quando um corretor move um lead para "Reunião", o placar atualiza na hora e o dashboard **emite alerta em tela cheia com campainha + locução em português** ("Atenção! Reunião agendada!").

Suporta duas contas Kommo, separadas por subdomínio:

| Subdomínio do dashboard | Conta Kommo |
| --- | --- |
| `dicasa.seudominio.com` | dicasa.kommo.com |
| `mazi.seudominio.com` | mazi.kommo.com |

## Como funciona

1. A Kommo envia um webhook (`POST /webhook/kommo`) a cada mudança de status de lead.
2. O servidor identifica a conta pelo `account[subdomain]` do payload (ou pelo subdomínio do host) e registra o evento em `data/events-<conta>.json`.
3. O dashboard, conectado via SSE (`/events`), recebe o evento na hora: o ranking reordena com animação, o corretor que pontuou pisca em destaque e, se o novo status for de "Reunião", abre um alerta em tela cheia com som contínuo (campainha + voz) até alguém clicar em **"OK, visto!"**. A lista de corretores vem da API da Kommo (token no `.env`), então quem ainda não pontuou também aparece, zerado.

## Instalação

```bash
npm install
```

Copie `.env.example` para `.env` e configure (já existe um `.env` inicial):

- `DASH_USER` / `DASH_PASS` — login global do dashboard. Cada conta também aceita **até 3 usuários próprios**: `DICASA_DASH_USER1`/`DICASA_DASH_PASS1` até `..._USER3`/`..._PASS3` (idem `MAZI_...`). Se a conta tiver usuários próprios, **só eles** logam nela; sem nenhum, valem as credenciais globais.
- `SESSION_SECRET` — string longa e aleatória.
- `DICASA_KOMMO_TOKEN` / `MAZI_KOMMO_TOKEN` — token de longa duração da Kommo (Configurações → Integrações → sua integração → token). **Opcional, mas recomendado**: com ele o dashboard mostra o *nome* do status e do corretor, e detecta automaticamente qualquer status cujo nome contenha "reuni" (Reunião, Reunião agendada, …).
- `DICASA_MEETING_STATUS_IDS` / `MAZI_MEETING_STATUS_IDS` — alternativa manual: IDs dos status de reunião, separados por vírgula (ex.: `42625614,42625617`). Têm prioridade sobre a detecção automática.
- `DICASA_DONE_STATUS_IDS` / `MAZI_DONE_STATUS_IDS` — IDs dos status de reunião **realizada** (barra verde do placar). Vazio = detecta pelo nome do status ("reuni" + "realizad").
- `META_CORRETOR` (padrão 25) e `META_TIME` (padrão 20) — metas mensais exibidas no placar (por corretor e do time); aceitam versão por conta (`DICASA_META_CORRETOR`, etc.).
- `WEBHOOK_SECRET` — se definido, o webhook exige `?secret=...` na URL.

Iniciar:

```bash
npm start
```

## Configurando o webhook na Kommo

Em **cada conta** Kommo (dicasa e mazi):

1. Configurações → Integrações → Webhooks (ou dentro da sua integração privada).
2. Adicione um webhook com o evento **"Status do lead alterado"** (e opcionalmente "Lead adicionado").
3. URL: `https://dicasa.seudominio.com/webhook/kommo` (ou o subdomínio correspondente). Como o payload da Kommo já traz `account[subdomain]`, a mesma URL funciona para as duas contas, mas usar o subdomínio certo ajuda na organização.
   - Com `WEBHOOK_SECRET` definido: `https://dicasa.seudominio.com/webhook/kommo?secret=SEU_SEGREDO`

## DNS / proxy reverso

Aponte os dois subdomínios para o servidor (registros A/CNAME `dicasa` e `mazi`). Com Nginx/Caddy/Cloudflare Tunnel na frente, basta encaminhar ambos os hosts para `localhost:3000` — o app resolve a conta pelo header `Host`.

Exemplo Caddy:

```
dicasa.seudominio.com, mazi.seudominio.com {
    reverse_proxy localhost:3000
}
```

## Desenvolvimento local (sem subdomínio)

Use o parâmetro `?account=`:

- `http://localhost:3000/?account=dicasa`
- `http://localhost:3000/?account=mazi`

Simule um webhook da Kommo:

```bash
curl -X POST "http://localhost:3000/webhook/kommo" -H "Content-Type: application/x-www-form-urlencoded" --data "account[subdomain]=dicasa&leads[status][0][id]=101&leads[status][0][name]=Maria Silva&leads[status][0][status_id]=42625614&leads[status][0][old_status_id]=42625611&leads[status][0][price]=350000&leads[status][0][responsible_user_id]=555"
```

Ou clique em **"Testar alerta"** no próprio dashboard.

## Observações

- **Som**: navegadores bloqueiam áudio sem interação — clique em **"Ativar som"** uma vez em cada máquina/aba que ficará monitorando (a preferência fica salva).
- **Persistência**: eventos ficam em `data/events-<conta>.json` (últimos 500 por conta). Sem banco de dados.
- **Reset mensal + histórico**: o ranking mostra sempre o mês atual e zera automaticamente na virada. Cada reunião também é consolidada em `data/stats-<conta>.json` (mês → corretor → agendadas/realizadas), permanente; as setas ◀ ▶ ao lado do mês no placar navegam pelos meses anteriores (badge HISTÓRICO). Alertas de teste não entram no histórico.
- **Sem token e sem IDs configurados**, nenhum evento é marcado como reunião — configure pelo menos um dos dois.
