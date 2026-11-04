import { randomBytes } from "node:crypto";
import { closeSync, fchmodSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Create a development-only secret without printing it or replacing user settings. */
export function createLocalEnvironment(directory, log = console.log) {
  const destination = resolve(directory, ".dev.vars");
  let descriptor;
  try {
    descriptor = openSync(destination, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    log("Файл .dev.vars уже существует; ваши настройки сохранены.");
    return false;
  }

  try {
    if (process.platform !== "win32") fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, [
      "# Только локальная разработка. Не публикуйте этот файл.",
      `PASSWORD_PEPPER=${randomBytes(32).toString("hex")}`,
      "# Тестовый владелец эмулятора Sites на localhost; это не облачный аккаунт.",
      "SITE_OWNER_EMAIL=seedy@sites.test",
      "",
    ].join("\n"), "utf8");
  } catch (error) {
    closeSync(descriptor);
    unlinkSync(destination);
    throw error;
  }
  closeSync(descriptor);
  log("Создан .dev.vars с новым локальным ключом. Значение ключа не выводится.");
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createLocalEnvironment(fileURLToPath(new URL("../", import.meta.url)));
}
