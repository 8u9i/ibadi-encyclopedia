import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import org.apache.lucene.document.Document;
import org.apache.lucene.index.*;
import org.apache.lucene.store.FSDirectory;
import org.apache.lucene.util.Bits;

/**
 * Exports every stored field of every live document of a Lucene index as JSON Lines (UTF-8).
 * Usage: java LuceneExport <indexDir> <out.jsonl>
 * Line endings inside values are normalised to "\n".
 */
public class LuceneExport {
  public static void main(String[] a) throws Exception {
    Path in = Paths.get(a[0]);
    Path out = Paths.get(a[1]);
    long n = 0;
    try (DirectoryReader r = DirectoryReader.open(FSDirectory.open(in));
         Writer w = new BufferedWriter(new OutputStreamWriter(Files.newOutputStream(out), StandardCharsets.UTF_8), 1 << 20)) {
      StoredFields sf = r.storedFields();
      Bits live = MultiBits.getLiveDocs(r);
      StringBuilder sb = new StringBuilder(1 << 16);
      for (int d = 0; d < r.maxDoc(); d++) {
        if (live != null && !live.get(d)) continue;
        Document doc = sf.document(d);
        sb.setLength(0);
        sb.append('{');
        boolean first = true;
        for (var f : doc.getFields()) {
          String v = f.stringValue();
          if (v == null && f.numericValue() != null) v = String.valueOf(f.numericValue());
          if (v == null) continue; // binary fields are not used by this data set
          if (!first) sb.append(',');
          first = false;
          str(sb, f.name());
          sb.append(':');
          str(sb, v.replace("\r\n", "\n").replace('\r', '\n'));
        }
        sb.append("}\n");
        w.write(sb.toString());
        n++;
      }
    }
    System.out.println(in.getFileName() + ": " + n + " docs");
  }

  static void str(StringBuilder sb, String s) {
    sb.append('"');
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      switch (c) {
        case '"': sb.append("\\\""); break;
        case '\\': sb.append("\\\\"); break;
        case '\n': sb.append("\\n"); break;
        case '\t': sb.append("\\t"); break;
        default:
          if (c < 0x20 || c == 0x2028 || c == 0x2029) sb.append(String.format("\\u%04x", (int) c));
          else sb.append(c);
      }
    }
    sb.append('"');
  }
}
