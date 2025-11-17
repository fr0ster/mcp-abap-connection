# Auto-Refresh Logic Improvements

## Проблема
JWT token refresh спрацьовував не завжди через складну перевірку `isJwtExpiredError()`, яка аналізувала текст помилки. Це призводило до того, що деякі 401/403 помилки не викликали refresh.

## Рішення

### 1. Спрощена логіка refresh (BaseAbapConnection.ts)

**Було:**
```typescript
if (error.response.status === 401/403 && isJwtExpiredError(error)) {
  // try refresh
}
```

**Стало:**
```typescript
if (error.response.status === 401/403) {
  if (canRefreshToken()) {
    // try refresh
  }
}
```

### 2. Основні зміни

#### Для JWT authentication:
- **Будь-який 401/403** викликає спробу refresh (якщо є refresh token)
- Якщо refresh успішний → retry запиту з новим токеном
- Якщо refresh не вдався → викидає помилку "Please re-authenticate"

#### Для Basic authentication:
- 401 на GET запитах → спроба отримати cookies
- Перевіряється `authType === 'basic'` замість складного `isJwtExpiredError()`

### 3. Видалені складні перевірки

Функція `isJwtExpiredError()` більше **не використовується** для логіки retry. Вона залишена тільки для логування (зворотна сумісність).

Замість неї перевіряється:
```typescript
this.config.authType === 'jwt'  // Простіше і надійніше
```

## Переваги

✅ **Надійніше** - не залежить від тексту помилки (може бути німецькою, англійською, тощо)
✅ **Простіше** - менше умов, зрозуміліша логіка
✅ **Швидше** - одразу спроба refresh замість аналізу тексту помилки
✅ **Універсальніше** - працює для всіх 401/403, не тільки для "expired token"

## Поведінка

### Сценарій 1: JWT token expired
1. API повертає 401/403
2. Connection перевіряє: `canRefreshToken()` → true
3. Викликає `refreshToken()` (UAA OAuth endpoint)
4. Отримує новий access_token + refresh_token
5. Retry запиту з новим токеном
6. ✅ Запит успішний

### Сценарій 2: JWT + refresh token також expired
1. API повертає 401/403
2. Connection перевіряє: `canRefreshToken()` → true
3. Викликає `refreshToken()` → **помилка** (refresh token теж expired)
4. ❌ Викидає: "JWT token has expired and refresh failed. Please re-authenticate."
5. Test helper ловить помилку, викликає `markAuthFailed()`
6. Наступні тести skipaються

### Сценарій 3: Basic auth (без JWT)
1. API повертає 401 на GET
2. Connection перевіряє: `authType === 'basic'` → true
3. Спроба retry з cookies
4. ✅ Запит успішний або помилка (але не refresh)

## Тестування

Перевірте:
```bash
# Видаліть .env щоб токен став invalid
rm .env

# Запустіть auth з існуючим refresh token в .env.backup
cp .env.backup .env
npm run auth -- -k service-key.json

# Повинно автоматично refresh-нути токен
```

## Файли змінені

- `packages/connection/src/connection/BaseAbapConnection.ts`:
  - Спрощено auto-refresh логіку (рядки ~513-548)
  - Замінено `isJwtExpiredError()` на `authType === 'jwt'` (рядки ~473, ~936)
  - Видалено `&& isJwtExpiredError()` умову з retry логіки
