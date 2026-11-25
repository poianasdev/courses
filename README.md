# Meus Cursos (Google Drive) + Fornecedores

Front-end estático (HTML/CSS/JS puro, sem build) pronto para GitHub Pages.

- **Home**: módulos em cards (capa, badge "Módulo NN", barra de progresso) e "Continuar assistindo".
- **Player**: vídeo do Drive + lista lateral "Aulas" (miniaturas, checkbox de concluída, módulos recolhíveis).
- **Fornecedores**: CRUD em cards (nome, nicho, contato, site, PDF do catálogo), filtro por nicho e busca por nome.

## 1) Google Cloud (uma vez)
1. https://console.cloud.google.com → criar projeto → ativar **Google Drive API**.
2. Tela de consentimento OAuth → *Externo* → adicione seu e-mail em **Usuários de teste**.
3. Credenciais → **ID do cliente OAuth** → *Aplicativo da Web*.
   Origens JavaScript autorizadas (só origem, sem caminho):
   - `http://localhost:8080`
   - `https://SEU-USUARIO.github.io`
4. Copie o Client ID (ele é público; não há segredo no projeto).

## 2) Testar localmente
```
python -m http.server 8080
```
Abra http://localhost:8080 → Configurações → Client ID + link da pasta raiz.

## 3) Publicar no GitHub Pages
```
git init
git add .
git commit -m "Meus Cursos"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/SEU-REPO.git
git push -u origin main
```
No repositório: **Settings → Pages → Build and deployment → Deploy from a branch → main / (root)**.
URL: `https://SEU-USUARIO.github.io/SEU-REPO/`

> Nenhum dado seu vai para o repositório: Client ID, pasta, progresso e fornecedores ficam no navegador de quem usa.

## Estrutura no Drive
```
Raiz/
  Curso A/
    01 - Primeiros Passos/  capa.jpg (opcional)  aula 01.mp4 ...
    02 - Envios e Logística/ ...
```
Sem `capa.jpg`, a capa do módulo usa a miniatura da primeira aula.

## Dados locais
Progresso → localStorage. Fornecedores + PDFs → IndexedDB (por navegador/domínio).
Use **Backup → Exportar JSON** para migrar (ex.: de localhost para o GitHub Pages).
