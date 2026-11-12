package com.oriadudai.maorat

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.text.InputType
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.webkit.WebViewAssetLoader
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * WebView shell around the shared UI (assets/index.html).
 * The page talks to the native side through window.Android:
 *   api(id, fn, argsJson)  -> POST to the Apps Script API with the saved key
 *   scan(id)               -> Google code scanner (live camera)
 *   openUrl(url)           -> open in the right app (WhatsApp / Goodreads / browser)
 *   openSettings()         -> paste the admin link (URL + key)
 * Results return through window.__native(id, ok, payload).
 */
class MainActivity : Activity() {

    private lateinit var web: WebView
    private val io = Executors.newFixedThreadPool(3)
    private val prefs by lazy { getSharedPreferences("config", Context.MODE_PRIVATE) }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        web = WebView(this)
        web.setBackgroundColor(0xFF131D29.toInt())
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest) =
                loader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                if (u.host == "appassets.androidplatform.net") return false
                openUrl(u.toString()); return true
            }
        }
        web.addJavascriptInterface(Bridge(), "Android")
        setContentView(web)
        web.loadUrl("https://appassets.androidplatform.net/assets/index.html")

        if (apiUrl().isEmpty()) web.postDelayed({ showSettings(firstRun = true) }, 600)
    }

    private fun apiUrl() = prefs.getString("url", "") ?: ""
    private fun apiKey() = prefs.getString("key", "") ?: ""

    // ---------- JS -> native ----------
    inner class Bridge {
        @JavascriptInterface
        fun api(id: Int, fn: String, argsJson: String) {
            io.execute {
                try {
                    if (apiUrl().isEmpty()) throw Exception("האפליקציה לא מחוברת. לחיצה ארוכה על הכותרת ← הגדרות")
                    val body = JSONObject()
                        .put("key", apiKey()).put("fn", fn)
                        .put("args", org.json.JSONArray(argsJson)).toString()
                    val res = JSONObject(httpPost(apiUrl(), body))
                    if (res.optBoolean("ok")) {
                        val r = res.opt("result")
                        reply(id, true, when (r) { null, JSONObject.NULL -> "null"; is String -> JSONObject.quote(r); else -> r.toString() })
                    }
                    else reply(id, false, res.optString("error", "שגיאה"))
                } catch (e: Exception) {
                    reply(id, false, if (e is java.io.IOException) "אין חיבור לאינטרנט" else (e.message ?: "שגיאה"))
                }
            }
        }

        @JavascriptInterface
        fun scan(id: Int) {
            runOnUiThread {
                val opts = GmsBarcodeScannerOptions.Builder()
                    .setBarcodeFormats(Barcode.FORMAT_EAN_13, Barcode.FORMAT_EAN_8, Barcode.FORMAT_UPC_A, Barcode.FORMAT_CODE_128)
                    .enableAutoZoom()
                    .build()
                GmsBarcodeScanning.getClient(this@MainActivity, opts).startScan()
                    .addOnSuccessListener { reply(id, true, JSONObject.quote(it.rawValue ?: "")) }
                    .addOnCanceledListener { reply(id, false, "בוטל") }
                    .addOnFailureListener { reply(id, false, "הסריקה נכשלה: " + it.message) }
            }
        }

        @JavascriptInterface
        fun openUrl(url: String) = runOnUiThread { this@MainActivity.openUrl(url) }

        @JavascriptInterface
        fun openSettings() = runOnUiThread { showSettings(firstRun = false) }
    }

    private fun reply(id: Int, ok: Boolean, payload: String) {
        val js = "window.__native($id, $ok, ${JSONObject.quote(payload)})"
        runOnUiThread { web.evaluateJavascript(js, null) }
    }

    /** POST, then follow Apps Script's redirect with a GET. */
    private fun httpPost(url: String, body: String): String {
        var c = URL(url).openConnection() as HttpURLConnection
        c.instanceFollowRedirects = false
        c.connectTimeout = 15000; c.readTimeout = 30000
        c.requestMethod = "POST"; c.doOutput = true
        c.setRequestProperty("Content-Type", "text/plain;charset=utf-8")
        c.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
        var hops = 0
        while (c.responseCode in 300..399 && hops++ < 5) {
            val next = c.getHeaderField("Location"); c.disconnect()
            c = URL(next).openConnection() as HttpURLConnection
            c.connectTimeout = 15000; c.readTimeout = 30000
        }
        return c.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
    }

    private fun openUrl(url: String) {
        try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
        catch (e: ActivityNotFoundException) { Toast.makeText(this, "אין אפליקציה שפותחת את הקישור", Toast.LENGTH_SHORT).show() }
    }

    // ---------- settings: paste the admin link https://script.google.com/.../exec?key=XXXX ----------
    private fun showSettings(firstRun: Boolean) {
        val pad = (20 * resources.displayMetrics.density).toInt()
        val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, pad / 2, pad, 0) }
        box.addView(TextView(this).apply {
            text = "הדביקי את קישור החיבור שקיבלת (מתחיל ב-https://script.google.com)"
        })
        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            hint = "https://script.google.com/macros/s/…/exec?key=…"
            if (apiUrl().isNotEmpty()) setText(apiUrl() + "?key=" + apiKey())
        }
        box.addView(input)
        AlertDialog.Builder(this)
            .setTitle(if (firstRun) "ברוכה הבאה למאורה 🐉" else "הגדרות חיבור")
            .setView(box)
            .setPositiveButton("שמירה") { _, _ ->
                val uri = Uri.parse(input.text.toString().trim())
                val key = uri.getQueryParameter("key")
                if (uri.scheme != "https" || key.isNullOrEmpty()) {
                    Toast.makeText(this, "הקישור לא תקין. צריך קישור שמכיל ?key=", Toast.LENGTH_LONG).show()
                    return@setPositiveButton
                }
                val base = uri.buildUpon().clearQuery().build().toString()
                prefs.edit().putString("url", base).putString("key", key).apply()
                web.reload()
            }
            .setNegativeButton("ביטול", null)
            .show()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        web.evaluateJavascript("window.__back && window.__back()") { closed ->
            if (closed != "true") {
                @Suppress("DEPRECATION")
                super.onBackPressed()
            }
        }
    }
}
