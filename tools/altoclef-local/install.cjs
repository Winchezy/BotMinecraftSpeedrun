const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '../..');
const libs = path.join(root, '.bot-state/altoclef-source-019/altoclef-0.19/versions/1.18.2/build/libs');
const artifact = path.join(libs, 'altoclef-1.18.2-0.19-local.3.jar');
if (!fs.existsSync(artifact)) throw Error('JAR local compilé absent');
const artifactHash = crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex');
const validation = JSON.parse(fs.readFileSync(path.join(root, '.bot-state/altoclef-downloads/local-jar-validation.json'), 'utf8').replace(/^\uFEFF/, ''));
if (!validation.java17Compatible || validation.sha256 !== artifactHash) throw Error('JAR non vérifié : exécute verify.ps1 avant installation.');
const javaProcesses = execFileSync('tasklist.exe', ['/FI', 'IMAGENAME eq javaw.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
if (/^"javaw.exe"/im.test(javaProcesses)) throw Error('Ferme Minecraft avant de remplacer le mod, puis relance cette commande.');
const mods = path.join(root, '.bot-state/altoclef-mirancz-instance/mods');
const jars = fs.readdirSync(mods).filter(name => name.endsWith('.jar'));
if (jars.length !== 1 || jars[0] !== 'altoclef-1.18.2-0.19.jar') throw Error('Contenu du dossier mods inattendu : installation interrompue.');
const destination = path.join(mods, jars[0]);
const backup = path.join(root, '.bot-state/altoclef-downloads/backups', `altoclef-before-local-${Date.now()}.jar`);
fs.mkdirSync(path.dirname(backup), { recursive: true });
fs.copyFileSync(destination, backup);
fs.copyFileSync(artifact, destination);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
if (hash(artifact) !== hash(destination)) {
  fs.copyFileSync(backup, destination);
  throw Error('Vérification du JAR échouée, ancien mod restauré.');
}
const result = { artifact, installed: destination, backup, sha256: hash(destination), installedAt: new Date().toISOString() };
fs.writeFileSync(path.join(root, '.bot-state/altoclef-downloads/local-install-result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
