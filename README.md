# GRG Cursos

Front-end estático (HTML/CSS/JS puro, sem build) para GitHub Pages.

- **Home**: só os cards dos cursos (quantos quiser).
- **Curso**: módulos em carrossel (setas, arrastar com o mouse, deslizar no celular) + botão Continuar/Começar.
- **Aula**: player nativo + lista lateral com checkbox de concluída e progresso. Retoma de onde parou e marca como concluída ao terminar.
- **✎ Editar**: em qualquer card de curso ou módulo, troque o título e a foto da capa (ou restaure o padrão).
- **Fornecedores**: CRUD em cards (contato, site, nicho, PDF do catálogo), filtro por nicho e busca por nome.

## Arquivos (suba todos)
`index.html`, `style.css`, `app.js`, `sw.js`, `.nojekyll`

`sw.js` é obrigatório: é ele que permite tocar o vídeo sem depender do iframe do Drive (que pede login quando o navegador bloqueia cookies de terceiros).

## Estrutura no Drive
Cada pasta que você adicionar em Configurações vira **um curso**; as subpastas viram os **módulos**:
```
Curso (pasta que você adiciona)/
  capa.jpg               (opcional: capa do curso)
  01 - Comece por aqui/
    capa.jpg             (opcional: capa do módulo)
    aula 01.mp4 ...
  02 - Método/ ...
```
Se a pasta adicionada contiver só uma subpasta (o curso) e nada mais, o app desce essa camada sozinho.

## Google Cloud (uma vez)
1. Projeto → ativar **Google Drive API**.
2. Tela de consentimento OAuth → Externo → adicione seu e-mail em **Usuários de teste**.
3. Credenciais → ID do cliente OAuth → *Aplicativo da Web*. Origens JavaScript autorizadas:
   `http://localhost:8080` e `https://SEU-USUARIO.github.io` (só a origem, sem caminho).
4. Cole o **Client ID** em ⚙️ Configurações (a secret não é usada).

## Atualizou e continua vendo a versão antiga?
GitHub Pages leva ~1–2 min para publicar e o navegador guarda cache. Abra o site e use **Ctrl+Shift+R** uma vez; depois, recarregue normalmente com F5 (o player precisa do Service Worker, que não é ativado em recarga forçada).

## Dados locais
Progresso e posição dos vídeos → localStorage. Fornecedores, PDFs, capas e títulos editados → IndexedDB (por navegador/domínio).
Use **Backup → Exportar/Importar** para migrar.
