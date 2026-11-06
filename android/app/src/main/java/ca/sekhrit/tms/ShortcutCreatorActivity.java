package ca.sekhrit.tms;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ShortcutInfo;
import android.content.pm.ShortcutManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

public class ShortcutCreatorActivity extends Activity {
    public static final String EXTRA_TARGET = "ca.sekhrit.tms.shortcut_creator.target";
    public static final String EXTRA_LABEL = "ca.sekhrit.tms.shortcut_creator.label";
    private static final int PICK_IMAGE = 420;
    private String target;
    private ImageView iconPreview;
    private EditText nameInput;
    private EditText emojiInput;
    private Bitmap selectedImage;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        target = getIntent().getStringExtra(EXTRA_TARGET);
        if (!isSafeTarget(target)) { finish(); return; }
        getWindow().setStatusBarColor(Color.rgb(17, 15, 27));
        getWindow().setNavigationBarColor(Color.rgb(17, 15, 27));
        setContentView(buildScreen());
    }

    private View buildScreen() {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(Color.rgb(17, 15, 27));
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(24), dp(24), dp(24), dp(28));
        content.setGravity(Gravity.CENTER_HORIZONTAL);
        scroll.addView(content, new ScrollView.LayoutParams(-1, -2));

        LinearLayout heading = new LinearLayout(this);
        heading.setGravity(Gravity.CENTER_VERTICAL);
        ImageButton close = new ImageButton(this);
        close.setImageResource(android.R.drawable.ic_menu_close_clear_cancel);
        close.setBackgroundColor(Color.TRANSPARENT);
        close.setColorFilter(Color.rgb(218, 211, 241));
        close.setContentDescription("Close");
        close.setOnClickListener(view -> finish());
        heading.addView(close, new LinearLayout.LayoutParams(dp(42), dp(42)));
        TextView title = text("Create shortcut", 24, Color.WHITE, true);
        LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(0, -2, 1);
        titleParams.setMargins(dp(8), 0, 0, 0);
        heading.addView(title, titleParams);
        content.addView(heading, new LinearLayout.LayoutParams(-1, -2));
        TextView subtitle = text("Choose how this TMS shortcut looks on your Home screen.", 14, Color.rgb(190, 184, 209), false);
        LinearLayout.LayoutParams subtitleParams = new LinearLayout.LayoutParams(-1, -2);
        subtitleParams.setMargins(0, dp(6), 0, dp(28));
        content.addView(subtitle, subtitleParams);

        iconPreview = new ImageView(this);
        iconPreview.setScaleType(ImageView.ScaleType.CENTER_CROP);
        iconPreview.setImageResource(R.mipmap.ic_launcher);
        GradientDrawable iconBackground = new GradientDrawable();
        iconBackground.setShape(GradientDrawable.OVAL);
        iconBackground.setColor(Color.rgb(48, 38, 73));
        iconPreview.setBackground(iconBackground);
        content.addView(iconPreview, new LinearLayout.LayoutParams(dp(112), dp(112)));

        TextView iconHint = text("Choose a photo or type an emoji", 13, Color.rgb(173, 164, 197), false);
        iconHint.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams hintParams = new LinearLayout.LayoutParams(-1, -2);
        hintParams.setMargins(0, dp(12), 0, dp(14));
        content.addView(iconHint, hintParams);

        Button photo = button("Choose picture", false);
        photo.setOnClickListener(view -> choosePicture());
        content.addView(photo, new LinearLayout.LayoutParams(-1, dp(52)));

        emojiInput = input("Emoji", "Example: 🌙", false);
        emojiInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        emojiInput.setTextSize(24);
        emojiInput.setGravity(Gravity.CENTER);
        emojiInput.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence value, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence value, int start, int before, int count) {}
            @Override public void afterTextChanged(Editable value) { refreshPreview(); }
        });
        LinearLayout.LayoutParams emojiParams = new LinearLayout.LayoutParams(-1, dp(58));
        emojiParams.setMargins(0, dp(12), 0, dp(24));
        content.addView(emojiInput, emojiParams);

        content.addView(label("Shortcut name"), new LinearLayout.LayoutParams(-1, -2));
        nameInput = input("Shortcut name", getIntent().getStringExtra(EXTRA_LABEL), false);
        LinearLayout.LayoutParams nameParams = new LinearLayout.LayoutParams(-1, dp(56));
        nameParams.setMargins(0, dp(8), 0, dp(24));
        content.addView(nameInput, nameParams);

        Button create = button("Add to Home screen", true);
        create.setOnClickListener(view -> createShortcut());
        content.addView(create, new LinearLayout.LayoutParams(-1, dp(54)));
        TextView privacy = text("Your photo and shortcut details stay on this device.", 12, Color.rgb(142, 134, 163), false);
        privacy.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams privacyParams = new LinearLayout.LayoutParams(-1, -2);
        privacyParams.setMargins(0, dp(14), 0, 0);
        content.addView(privacy, privacyParams);
        return scroll;
    }

    private void choosePicture() {
        Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("image/*").addCategory(Intent.CATEGORY_OPENABLE);
        startActivityForResult(picker, PICK_IMAGE);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != PICK_IMAGE || resultCode != RESULT_OK || data == null || data.getData() == null) return;
        try (InputStream stream = getContentResolver().openInputStream(data.getData())) {
            selectedImage = BitmapFactory.decodeStream(stream);
            emojiInput.setText("");
            refreshPreview();
        } catch (Exception error) {
            Toast.makeText(this, "Could not use that picture", Toast.LENGTH_SHORT).show();
        }
    }

    private void refreshPreview() {
        String emoji = emojiInput.getText().toString().trim();
        if (!emoji.isEmpty()) iconPreview.setImageBitmap(emojiBitmap(emoji));
        else if (selectedImage != null) iconPreview.setImageBitmap(squareBitmap(selectedImage));
        else iconPreview.setImageResource(R.mipmap.ic_launcher);
    }

    private void createShortcut() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) { unsupported(); return; }
        ShortcutManager manager = getSystemService(ShortcutManager.class);
        if (manager == null || !manager.isRequestPinShortcutSupported()) { unsupported(); return; }
        String label = nameInput.getText().toString().trim();
        if (label.isEmpty()) label = "TMS";
        String emoji = emojiInput.getText().toString().trim();
        Icon icon = !emoji.isEmpty() ? Icon.createWithAdaptiveBitmap(emojiBitmap(emoji))
            : selectedImage != null ? Icon.createWithAdaptiveBitmap(squareBitmap(selectedImage))
            : Icon.createWithResource(this, R.mipmap.ic_launcher);
        Intent launch = new Intent(this, MainActivity.class)
            .setAction(Intent.ACTION_VIEW)
            .putExtra(MainActivity.EXTRA_SHORTCUT_TARGET, target)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        // A pinned shortcut's ID is its identity to the launcher. Reusing the
        // target-only ID made the launcher keep the old default name/icon even
        // when the user selected a new emoji or picture. Every creation is a
        // distinct, user-customized launcher item.
        ShortcutInfo shortcut = new ShortcutInfo.Builder(this, "tms-" + stableId(target) + "-" + Long.toUnsignedString(System.nanoTime(), 36))
            .setShortLabel(label.length() > 40 ? label.substring(0, 40) : label)
            .setIcon(icon)
            .setIntent(launch)
            .build();
        manager.requestPinShortcut(shortcut, null);
        finish();
    }

    private void unsupported() { Toast.makeText(this, "Your launcher does not support Home screen shortcuts", Toast.LENGTH_LONG).show(); }
    private EditText input(String description, String hint, boolean multiline) {
        EditText input = new EditText(this);
        input.setContentDescription(description);
        input.setHint(hint == null ? "" : hint);
        input.setHintTextColor(Color.rgb(137, 129, 155));
        input.setTextColor(Color.WHITE);
        input.setTextSize(16);
        input.setSingleLine(!multiline);
        input.setPadding(dp(16), 0, dp(16), 0);
        GradientDrawable background = new GradientDrawable();
        background.setColor(Color.rgb(31, 27, 44));
        background.setStroke(dp(1), Color.rgb(76, 65, 105));
        background.setCornerRadius(dp(14));
        input.setBackground(background);
        return input;
    }
    private Button button(String value, boolean primary) {
        Button button = new Button(this);
        button.setAllCaps(false);
        button.setText(value);
        button.setTextSize(16);
        button.setTextColor(Color.WHITE);
        GradientDrawable background = new GradientDrawable();
        background.setColor(primary ? Color.rgb(128, 107, 234) : Color.rgb(45, 38, 64));
        background.setCornerRadius(dp(14));
        if (!primary) background.setStroke(dp(1), Color.rgb(91, 78, 124));
        button.setBackground(background);
        return button;
    }
    private TextView text(String value, int size, int color, boolean bold) { TextView view = new TextView(this); view.setText(value); view.setTextSize(size); view.setTextColor(color); if (bold) view.setTypeface(Typeface.DEFAULT, Typeface.BOLD); return view; }
    private TextView label(String value) { TextView view = text(value, 13, Color.rgb(218, 211, 241), true); return view; }
    private Bitmap squareBitmap(Bitmap source) { int size = Math.min(source.getWidth(), source.getHeight()); int left = (source.getWidth() - size) / 2; int top = (source.getHeight() - size) / 2; return Bitmap.createScaledBitmap(Bitmap.createBitmap(source, left, top, size, size), 192, 192, true); }
    private Bitmap emojiBitmap(String emoji) { Bitmap bitmap = Bitmap.createBitmap(192, 192, Bitmap.Config.ARGB_8888); Canvas canvas = new Canvas(bitmap); canvas.drawColor(Color.rgb(128, 107, 234)); Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG); paint.setTextAlign(Paint.Align.CENTER); paint.setTextSize(108); Paint.FontMetrics metrics = paint.getFontMetrics(); canvas.drawText(emoji, 96, 96 - (metrics.ascent + metrics.descent) / 2, paint); return bitmap; }
    private boolean isSafeTarget(String value) { return value != null && value.startsWith("/") && !value.startsWith("//"); }
    private String stableId(String value) { try { byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)); StringBuilder id = new StringBuilder(); for (int i = 0; i < 12; i++) id.append(String.format("%02x", digest[i])); return id.toString(); } catch (Exception ignored) { return Integer.toUnsignedString(value.hashCode(), 36); } }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
