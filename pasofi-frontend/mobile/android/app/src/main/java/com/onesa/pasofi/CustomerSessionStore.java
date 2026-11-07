package com.onesa.pasofi;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** App-private, origin-bound storage; never uses Preferences or WebView cookies. */
final class CustomerSessionStore {
    private final String origin, alias;
    private final AtomicFile file;
    private final byte[] associatedData;

    CustomerSessionStore(Context context, String origin) throws Exception {
        if (!CustomerApiPolicy.validOrigin(origin)) throw new IOException("invalid_origin");
        this.origin = origin;
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(origin.getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder();
        for (byte value : hash) hex.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        alias = "com.onesa.pasofi.customer.v1." + hex;
        file = new AtomicFile(new File(context.getNoBackupFilesDir(), "pasofi-customer-" + hex + ".bin"));
        associatedData = ("pasofi-customer-v1\n" + origin).getBytes(StandardCharsets.UTF_8);
    }

    synchronized CustomerSessionState load() throws Exception {
        byte[] bytes;
        try (FileInputStream input = file.openRead()) { bytes = bounded(input); }
        catch (FileNotFoundException missing) {
            if (file.getBaseFile().exists() || new File(file.getBaseFile().getPath() + ".bak").exists()) throw missing;
            return CustomerSessionState.empty();
        }
        if (bytes.length < 1 + 12 + 16 || bytes[0] != 1) throw new IOException("invalid_private_state");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, Arrays.copyOfRange(bytes, 1, 13)));
        cipher.updateAAD(associatedData);
        byte[] plaintext = cipher.doFinal(bytes, 13, bytes.length - 13);
        try { return CustomerSessionState.decode(origin, plaintext); }
        finally { Arrays.fill(plaintext, (byte) 0); }
    }

    synchronized void save(CustomerSessionState state) throws Exception {
        byte[] plaintext = state.encode(origin), encrypted;
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key(true)); cipher.updateAAD(associatedData);
            byte[] iv = cipher.getIV();
            if (iv.length != 12) throw new IOException("invalid_private_state");
            byte[] ciphertext = cipher.doFinal(plaintext);
            encrypted = new byte[1 + iv.length + ciphertext.length]; encrypted[0] = 1;
            System.arraycopy(iv, 0, encrypted, 1, iv.length); System.arraycopy(ciphertext, 0, encrypted, 13, ciphertext.length);
        } finally { Arrays.fill(plaintext, (byte) 0); }
        FileOutputStream output = null;
        try {
            output = file.startWrite(); output.write(encrypted); output.getFD().sync();
            file.finishWrite(output); output = null;
            // Do not proceed to a mutation if the replacement did not commit.
            try (FileInputStream input = file.openRead()) {
                if (!MessageDigest.isEqual(encrypted, bounded(input))) throw new IOException("private_state_unavailable");
            }
        } catch (Exception error) {
            if (output != null) file.failWrite(output);
            throw error;
        }
    }

    private SecretKey key(boolean mayCreate) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (store.containsAlias(alias)) {
            java.security.Key key = store.getKey(alias, null);
            if (!(key instanceof SecretKey)) throw new IOException("private_state_unavailable");
            return (SecretKey) key;
        }
        if (!mayCreate) throw new IOException("private_state_unavailable");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true).build());
        return generator.generateKey();
    }

    private static byte[] bounded(FileInputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream(); byte[] chunk = new byte[512]; int read;
        while ((read = input.read(chunk)) != -1) {
            if (output.size() + read > 8192) throw new IOException("invalid_private_state");
            output.write(chunk, 0, read);
        }
        return output.toByteArray();
    }
}
