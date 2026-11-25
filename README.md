# GRG Cursos

Front-end estático (HTML/CSS/JS puro, sem build) para GitHub Pages.

- **Home**: só os cards dos cursos (quantos quiser).
- **Curso**: módulos em carrossel (setas, arrastar com o mouse, deslizar no celular) + botão Continuar/Começar.
- **Aula**: player do Drive + lista lateral com checkbox de concluída e progresso.
- **✎ Editar**: em qualquer card de curso ou módulo, troque o título e a foto da capa (ou restaure o padrão).
- **Fornecedores**: CRUD em cards (contato, site, nicho, PDF do catálogo), filtro por nicho e busca por nome.

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
Vídeos soltos na pasta do curso entram no módulo "Aulas gerais". Subpastas dentro de um módulo são lidas e aparecem como subtítulo nas aulas.

## Google Cloud (uma vez)
1. Projeto → ativar **Google Drive API**.
2. Tela de consentimento OAuth → Externo → adicione seu e-mail em **Usuários de teste**.
3. Credenciais → ID do cliente OAuth → *Aplicativo da Web*. Origens JavaScript autorizadas:
   `http://localhost:8080` e `https://SEU-USUARIO.github.io` (só a origem, sem caminho).
4. Cole o **Client ID** em ⚙️ Configurações (a secret não é usada).

## Publicar no GitHub Pages
Suba a pasta no repositório → Settings → Pages → Deploy from a branch → main / (root).

## Dados locais
Progresso → localStorage. Fornecedores, PDFs, capas e títulos editados → IndexedDB (por navegador/domínio).
Use **Backup → Exportar/Importar** para migrar.
