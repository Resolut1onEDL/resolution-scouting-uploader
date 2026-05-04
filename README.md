# Resolution Scouting

Десктоп-агент для скаутинга Dota 2 игроков. Сканирует папку реплеев, парсит
`.dem` локально (dotabuff/manta), отправляет агрегированную стату и сжатый
`.dem.bz2` на [resolut1on.gg/scouting](https://www.resolut1on.gg/scouting).

Часть scouting-стека Resolution:
- **resolut1on.gg/scouting** — landing где игрок логинится через Steam OpenID
  и получает scouting-токен.
- **Этот installer** — скачивается оттуда, авторизуется одной кнопкой
  («Connect via Steam»), парсит реплеи, отправляет данные.
- **resolut1on.gg/admin/scouting** — leaderboard для админов: фильтры по
  позициям, hero pool, аггрегаты, drill-down с возможностью скачать .dem
  и посмотреть его в Dota client.

## Установка

Скачай свежий `.dmg` (Mac arm64) / `.exe` (Win x64) из
[Releases](https://github.com/Resolut1onEDL/resolution-scouting-uploader/releases).

После установки:
1. Открой приложение → нажми **«Connect via Steam»**.
2. Браузер откроется на resolut1on.gg/scouting → пройди Steam OpenID.
3. После успеха токен автоматически вернётся в installer.
4. Папка Dota 2 определяется автоматически. Если не нашло — выбери вручную.
5. Кнопка **«Перепарсить»** (с дропдауном «за 14/30/60/90 дней») загрузит
   твои существующие реплеи. По умолчанию — за последние 14 дней.
6. Каждая новая игра после установки будет отправляться автоматически.

## Архитектура

```
Dota 2 replays/
   ↓ chokidar watcher
parser-runner.js → bundled Go binary (manta v3.1.4+)
   ↓ parsed JSON
POST /functions/v1/scouting-upload  →  scouting_replays row
   ↓ (signed upload URL in response)
PUT .dem.bz2 → Supabase Storage scouting-replays-raw bucket
```

Backend живёт в Supabase project, привязанном к resolut1on.gg.
Скомпилированные Go-бинари парсера — в
[`Resolut1onEDL/dota-replay-parser`](https://github.com/Resolut1onEDL/dota-replay-parser).
Версия парсера пинится в `package.json` поле `parserVersion`.

## Разработка

```bash
npm install        # downloads parser binaries (postinstall script)
npm run dev        # электрон с DevTools
npm run build:mac  # local build .dmg
npm run build:win  # local build .exe
```

## CI

Push tag `v*` → GitHub Actions собирает Mac arm64 и Win x64 installers,
прикладывает к release с `latest.yml` для electron-updater auto-update.

## Mac Gatekeeper

Билд unsigned (нет Apple Developer ID). При первом запуске:
- Right-click на иконке → Open → подтвердить
- ИЛИ: `xattr -d com.apple.quarantine /Applications/Resolution\ Scouting.app`

## License

MIT
