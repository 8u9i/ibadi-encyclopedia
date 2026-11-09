import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.HashSet;
import java.util.Set;
import org.apache.lucene.document.Document;
import org.apache.lucene.index.*;
import org.apache.lucene.search.DocIdSetIterator;
import org.apache.lucene.store.FSDirectory;
import org.apache.lucene.util.Bits;

/**
 * Exports every stored field of live documents of a Lucene index as JSON Lines (UTF-8).
 *
 *   java LuceneExport <indexDir> <out.jsonl> [bookIdsFile]
 *
 * With bookIdsFile (one numeric id per line) only documents whose numeric doc value "book" is in
 * the set are exported; the doc values are scanned without decompressing any stored fields, so a
 * handful of books is extracted in about a second. Line endings inside values become "\n".
 */
public class LuceneExport {
  public static void main(String[] a) throws Exception {
    Path in = Paths.get(a[0]);
    Path out = Paths.get(a[1]);
    Set<Long> books = null;
    if (a.length > 2) {
      books = new HashSet<>();
      for (String line : Files.readAllLines(Paths.get(a[2]), StandardCharsets.UTF_8)) {
        line = line.trim();
        if (!line.isEmpty()) books.add(Long.parseLong(line));
      }
    }
    long n = 0;
    try (DirectoryReader r = DirectoryReader.open(FSDirectory.open(in));
         Writer w = new BufferedWriter(new OutputStreamWriter(Files.newOutputStream(out), StandardCharsets.UTF_8), 1 << 20)) {
      StringBuilder sb = new StringBuilder(1 << 16);
      for (LeafReaderContext ctx : r.leaves()) {
        LeafReader leaf = ctx.reader();
        Bits live = leaf.getLiveDocs();
        StoredFields sf = leaf.storedFields();
        NumericDocValues bookDv = books == null ? null : leaf.getNumericDocValues("book");
        if (books != null && bookDv == null) continue; // no book doc values in this segment: nothing to select
        for (int d = 0; d < leaf.maxDoc(); d++) {
          if (live != null && !live.get(d)) continue;
          if (books != null) {
            if (bookDv.docID() < d && bookDv.advance(d) == DocIdSetIterator.NO_MORE_DOCS) break;
            if (bookDv.docID() != d || !books.contains(bookDv.longValue())) continue;
          }
          n += write(w, sb, sf.document(d));
        }
      }
    }
    System.out.println(in.getFileName() + ": " + n + " docs");
  }

  static int write(Writer w, StringBuilder sb, Document doc) throws IOException {
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
    return 1;
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
