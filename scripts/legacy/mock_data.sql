INSERT INTO contents (
  pk, source_type, source_id, title, author_name, content_html, content_md,
  voteup_count, comment_count, content_hash, first_seen_at, last_seen_at, created_time, updated_time
) VALUES (
  'answer:123', 'answer', '123', '这是一个测试回答的标题', '测试作者',
  '<p>这是第一阶段改造后插入的测试数据内容，用来证明所有前端功能都还在！</p>',
  '这是第一阶段改造后插入的测试数据内容，用来证明所有前端功能都还在！',
  999, 10, 'testhash', '2023-01-01T00:00:00Z', '2023-01-01T00:00:00Z', '2023-01-01T00:00:00Z', '2023-01-01T00:00:00Z'
);

INSERT INTO comments (
  id, content_pk, author_name, content_md, likes, comment_hash, first_seen_at, last_seen_at
) VALUES (
  'comment1', 'answer:123', '热心网友', '看到有数据就放心了！', 88, 'hash1', '2023-01-01T00:00:00Z', '2023-01-01T00:00:00Z'
);
