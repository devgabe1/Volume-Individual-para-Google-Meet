<p align="center">
  <img src="extension/icons/icon128.png" width="96" height="96" alt="">
</p>

<h1 align="center">Volume Individual para Google Meet</h1>

<p align="center">
  Ajuste o volume de cada participante do Google Meet separadamente — como no Discord.
</p>

---

## Recursos

- **Volume por pessoa** de 0% a 200%, com botão de silenciar.
- **Controle direto no vídeo**: passe o mouse sobre o quadro de alguém para ajustar.
- **Nomes automáticos**: a extensão descobre quem é cada voz sozinha.
- **Volumes lembrados** por nome entre chamadas.
- **Igualar volumes** (opcional): aproxima quem fala alto de quem fala baixo e evita som estourado.
- **Painel arrastável** com a lista de quem falou por último no topo.
- **Avisos** quando algo deixa de funcionar (por exemplo, depois de uma atualização do Meet).
- **Página de opções** para revisar e apagar volumes salvos.
- **Privacidade**: nenhum dado sai do navegador. Sem servidores, sem analytics.

## Instalação

### Chrome Web Store

_Em breve._

### Modo desenvolvedor

1. Baixe ou clone este repositório.
2. Abra `chrome://extensions` e ative o **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação** e selecione a pasta [`extension/`](extension).
4. Entre numa chamada do Meet: o botão de volume aparece na barra de controles, ao lado do microfone.

## Como funciona

O Google Meet não envia um áudio separado por participante. Ele usa poucos canais
de áudio e troca quem está em cada um conforme quem fala. Por isso a extensão:

1. **Intercepta o áudio remoto.** Envolve o `RTCPeerConnection` para saber quais
   faixas são remotas e o setter de `srcObject` dos `<audio>` para passar cada
   canal por um `GainNode` (Web Audio) antes de tocar. O Meet continua tocando no
   mesmo elemento, então o dispositivo de saída escolhido é respeitado.
2. **Descobre quem está falando em cada canal.** O RTP do Meet carrega o
   identificador do participante original (CSRC). A cada 10 ms a extensão lê
   `receiver.getContributingSources()` e aplica o volume daquela pessoa.
3. **Dá nome às vozes.** Cruza estatisticamente "voz X ativa" com "quadro do
   participante Y animando" (o indicador de fala do Meet). Não depende de classes
   CSS do Meet, que mudam com frequência.
4. **Evita picos na troca.** Quando o canal passa de uma pessoa para outra, usa o
   menor volume entre as duas por ~60 ms e faz uma rampa curta, sem clique.

```
RTCPeerConnection ─► <audio>.srcObject (interceptado)
                          │
                          ▼
   MediaStreamSource ─► Gain (volume da pessoa) ─┬─► dry ────────────────────┐
                                                 └─► Compressor ─► Limiter ─► wet ─┤
                                                                                   ▼
                                               MediaStreamDestination ─► <audio> do Meet
```

### Arquivos

| Arquivo | Função |
|---|---|
| [`extension/inject.js`](extension/inject.js) | Roda na página do Meet (`world: MAIN`): áudio, identificação e painel. |
| [`extension/bridge.js`](extension/bridge.js) | Ponte entre a página e o `chrome.storage`. |
| [`extension/options.html`](extension/options.html) | Página de opções. |
| [`extension/background.js`](extension/background.js) | Abre as opções ao clicar no ícone da extensão. |
| [`assets/icon.svg`](assets/icon.svg) | Fonte do ícone. |
| [`scripts/build-icons.py`](scripts/build-icons.py) | Gera os PNGs do ícone a partir do SVG. |
| [`scripts/pack.ps1`](scripts/pack.ps1) | Gera o `.zip` para a Chrome Web Store. |

## Desenvolvimento

Depois de editar, recarregue a extensão em `chrome://extensions` e recarregue a aba
do Meet.

Para depurar, use o console da aba do Meet:

```js
__meetVolume.voices    // vozes detectadas
__meetVolume.health()  // avisos atuais
__meetVolume.stats     // estatísticas da identificação automática
__meetVolume.channels() // canais de áudio: voz atual, ganho e CSRCs informados pelo Meet
__meetVolume.tileName(document.querySelector('[data-participant-id]').dataset.participantId)
                       // nome lido de um quadro
```

Gerar ícones (requer Python com Pillow e o Chrome instalado):

```bash
python scripts/build-icons.py
```

Gerar o pacote para a loja:

```bash
powershell -ExecutionPolicy Bypass -File scripts/pack.ps1
```

O passo a passo de publicação está em [`docs/PUBLICAR.md`](docs/PUBLICAR.md).

## Limitações

- Depende de detalhes internos do Meet (CSRC no RTP e `data-participant-id` nos
  quadros). Se o Meet mudar, o painel mostra um aviso.
- A identificação automática precisa que cada pessoa fale sozinha por 1–2 segundos.
- Volumes são lembrados por **nome**: duas pessoas com o mesmo nome compartilham o volume.

## Privacidade

Veja [PRIVACY.md](PRIVACY.md). Resumo: tudo fica no seu navegador.

## Licença

[MIT](LICENSE). Este projeto não é afiliado ao Google. Google Meet é marca do Google LLC.
