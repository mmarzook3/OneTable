package uk.scanaki.kitchen;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.LinkedHashMap;
import java.util.Map;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Private app storage. Credentials are encrypted; the journal contains IDs only. */
final class PrinterStore implements PrinterEngine.Journal {
    private static final String KEY = "scanaki-printer-config-v1";
    private final SharedPreferences prefs;
    PrinterStore(Context context) { prefs = context.getSharedPreferences("printer", Context.MODE_PRIVATE); }
    boolean enabled() { return prefs.getBoolean("enabled", false); }
    void setEnabled(boolean value) {
        if (!prefs.edit().putBoolean("enabled", value).commit()) throw new IllegalStateException("Storage unavailable");
    }
    void status(String value) { prefs.edit().putString("status", value).apply(); }
    String status() { return prefs.getString("status", "Printer not configured"); }
    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(KEY)) return (SecretKey) store.getKey(KEY, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }
    JSONObject config() throws Exception {
        String value = prefs.getString("config", null);
        if (value == null) return null;
        String[] parts = value.split(":", 2);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
        return new JSONObject(new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8));
    }
    void configure(JSONObject value) throws Exception {
        if (!pending().isEmpty()) throw new IllegalStateException("Recover outstanding tickets before changing pairing");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        String encrypted = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":"
            + Base64.encodeToString(cipher.doFinal(value.toString().getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
        if (!prefs.edit().putString("config", encrypted).commit()) throw new IllegalStateException("Storage unavailable");
    }
    @Override public synchronized Map<Long, Boolean> pending() {
        try {
            JSONObject data = new JSONObject(prefs.getString("journal", "{}"));
            Map<Long, Boolean> result = new LinkedHashMap<>();
            java.util.Iterator<String> keys = data.keys();
            while (keys.hasNext()) { String id = keys.next(); result.put(Long.parseLong(id), data.getBoolean(id)); }
            return result;
        } catch (Exception error) { throw new IllegalStateException("Recovery record unreadable"); }
    }
    @Override public synchronized void save(long id, boolean sent) {
        Map<Long, Boolean> data = pending(); data.put(id, sent); writeJournal(data);
    }
    @Override public synchronized void remove(long id) {
        Map<Long, Boolean> data = pending(); data.remove(id); writeJournal(data);
    }
    private void writeJournal(Map<Long, Boolean> data) {
        JSONObject json = new JSONObject();
        try { for (Map.Entry<Long, Boolean> entry : data.entrySet()) json.put(entry.getKey().toString(), entry.getValue()); }
        catch (Exception error) { throw new IllegalStateException("Recovery storage unavailable"); }
        if (!prefs.edit().putString("journal", json.toString()).commit()) throw new IllegalStateException("Recovery storage unavailable");
    }
    static boolean validHost(String host) {
        String[] parts = host.split("\\.", -1);
        if (parts.length != 4) return false;
        int[] octets = new int[4];
        for (int index = 0; index < 4; index++) {
            if (!parts[index].matches("0|[1-9][0-9]{0,2}")) return false;
            octets[index] = Integer.parseInt(parts[index]);
            if (octets[index] > 255) return false;
        }
        return octets[0] == 10 || (octets[0] == 192 && octets[1] == 168)
            || (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31);
    }
}
