# NWN Архетипы Клиентов - Audio Podcasts Integration

Веб-приложение для обучения персонала работе с архетипами клиентов с интеграцией аудио-подкастов из Cloudflare R2.

## Особенности

- **Безопасный стриминг**: Аудио файлы не могут быть скачаны напрямую
- **Signed URLs**: Временные ссылки с ограниченным временем жизни (5-10 минут)
- **Content-Disposition: inline**: Принудительный стриминг вместо скачивания
- **13 подкастов**: По одному для каждого архетипа клиента

## Структура проекта

```
/workspace/
├── index.html          # Фронтенд с интегрированным аудио-плеером
├── server.js           # Backend сервер с /audio-url endpoint
├── package.json        # Node.js зависимости
├── .env.example        # Пример конфигурации
└── README.md           # Документация
```

## Требования

- Node.js >= 18.0.0
- Cloudflare R2 bucket (private)
- R2 API credentials

## Установка

### 1. Установите зависимости

```bash
npm install
```

### 2. Настройте переменные окружения

Скопируйте `.env.example` в `.env` и заполните значения:

```bash
cp .env.example .env
```

Отредактируйте `.env`:

```env
# Cloudflare R2 Configuration
R2_ACCOUNT_ID=your_account_id_here
R2_ACCESS_KEY_ID=your_access_key_id_here
R2_SECRET_ACCESS_KEY=your_secret_access_key_here
R2_BUCKET_NAME=podcasts

# Server Configuration
PORT=3000
URL_EXPIRATION_SECONDS=600
```

### 3. Получите R2 API credentials

1. Войдите в [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Перейдите в **R2** > **Manage R2 API Tokens**
3. Создайте новый API токен с правами на чтение bucket
4. Скопируйте:
   - Account ID (из URL: `https://dash.cloudflare.com/{account_id}/r2`)
   - Access Key ID
   - Secret Access Key

### 4. Загрузите аудио файлы в R2

Загрузите MP3 файлы для каждого архетипа:

| Архетип | Файл | Описание |
|---------|------|----------|
| Введение | `intro.mp3` | Общее введение в архетипы |
| Творец | `creator.mp3` | Творческий архетип |
| Правитель | `ruler.mp3` | Статусный архетип |
| Заботливый | `caregiver.mp3` | Заботливый архетип |
| Мыслитель | `sage.mp3` | Мыслительный архетип |
| Ребенок | `child.mp3` | Детский архетип |
| Славный малый | `everyman.mp3` | Социальный архетип |
| Шут | `jester.mp3` | Юмористический архетип |
| Любовник | `lover.mp3` | Эстетический архетип |
| Бунтарь | `outlaw.mp3` | Бунтарский архетип |
| Искатель | `explorer.mp3` | Исследовательский архетип |
| Герой | `hero.mp3` | Героический архетип |
| Маг | `magician.mp3` | Магический архетип |

## Запуск

### Разработка

```bash
npm start
```

Сервер запустится на `http://localhost:3000`

### Production

Рекомендуется использовать PM2 или подобный менеджер процессов:

```bash
npm install -g pm2
pm2 start server.js --name nwn-archetypes
```

## API Endpoints

### GET /audio-url

Получение signed URL для аудио файла.

**Parameters:**
- `filename` (query) - имя файла (например: `intro.mp3`)

**Response:**
```json
{
  "success": true,
  "url": "https://..../intro.mp3?X-Amz-...",
  "expiresIn": 600,
  "filename": "intro.mp3"
}
```

### POST /audio-url

Альтернативный endpoint с filename в теле запроса.

**Body:**
```json
{
  "filename": "intro.mp3"
}
```

### GET /health

Проверка состояния сервера.

**Response:**
```json
{
  "status": "ok",
  "r2Configured": true,
  "bucket": "podcasts",
  "urlExpirationSeconds": 600
}
```

## Тестирование

### 1. Проверка воспроизведения в браузере

1. Откройте `http://localhost:3000`
2. Выберите любой архетип
3. Нажмите кнопку воспроизведения подкаста
4. Убедитесь, что аудио воспроизводится

### 2. Проверка защиты от прямого доступа

1. Попробуйте открыть файл напрямую в R2 без signed URL
   - Должен вернуться статус 403 (Forbidden)

2. Проверьте bucket settings в Cloudflare:
   - Bucket должен быть **Private** (не Public)

### 3. Проверка истечения ссылок

1. Получите signed URL через `/audio-url`
2. Подождите более 10 минут (или измените `URL_EXPIRATION_SECONDS` на меньшее значение для теста)
3. Попробуйте открыть URL - должна вернуться ошибка

### 4. Проверка Content-Disposition

1. Откройте Network tab в DevTools
2. Воспроизведите подкаст
3. Проверьте заголовки ответа:
   - `Content-Disposition: inline` (не attachment)

### Тестовые команды

```bash
# Проверка health endpoint
curl http://localhost:3000/health

# Получение signed URL
curl "http://localhost:3000/audio-url?filename=intro.mp3"

# Проверка что прямой URL не работает без подписи
curl -I "https://{account_id}.r2.cloudflarestorage.com/{bucket}/intro.mp3"
# Должен вернуть 403
```

## Безопасность

### Реализованные меры

1. **Private R2 Bucket** - файлы недоступны публично
2. **Signed URLs** - временные ссылки с ограниченным сроком действия
3. **Content-Disposition: inline** - принудительный стриминг
4. **Filename validation** - защита от path traversal
5. **CORS configuration** - ограничение источников запросов
6. **controlsList="nodownload"** - отключение кнопки скачивания в audio элементе

### Рекомендации для production

1. Установите `ALLOWED_ORIGINS` в `.env` для ограничения CORS
2. Используйте HTTPS
3. Настройте rate limiting
4. Мониторьте использование R2 API

## Структура аудио плеера

Плеер интегрирован в каждую карточку архетипа и включает:

- Кнопка Play/Pause с анимацией
- Индикатор загрузки
- Прогресс-бар с возможностью перемотки
- Отображение текущего времени и длительности
- Автоматическая остановка при переключении архетипа

## Troubleshooting

### Ошибка "Storage not configured"

Проверьте что все переменные окружения установлены в `.env`:
- R2_ACCOUNT_ID
- R2_ACCESS_KEY_ID  
- R2_SECRET_ACCESS_KEY

### Ошибка "File not found"

1. Проверьте что файл существует в R2 bucket
2. Проверьте имя файла (регистр важен)
3. Проверьте что R2_BUCKET_NAME правильный

### Ошибка CORS

1. Проверьте что сервер запущен
2. Проверьте ALLOWED_ORIGINS в `.env`
3. Убедитесь что запрос идет на правильный порт

### Аудио не воспроизводится

1. Проверьте формат файла (поддерживаются: mp3, wav, ogg, m4a, aac, webm)
2. Проверьте консоль браузера на ошибки
3. Попробуйте в другом браузере

## Лицензия

© 2025 NWN Retail - Confidential
