# QRFile protocol notes

本文档描述 PWA 当前实现所对齐的 Python `qrfile.py` 协议。所有多字节整数使用 big-endian。

## QR 文本编码

每个二维码承载 Base45 文本。解码后首先根据前 4 字节 magic 判断记录类型。

## QRF1 data frame

```text
4s  magic = "QRF1"
8s  file_id
H   index              # 0-based
H   total_data_frames
H   payload_len
I   crc32
... payload
```

CRC32 输入不是整个含 CRC 的 header，而是：

```text
magic + file_id + index + total + payload_len + payload
```

Python struct：

```text
>4s8sHHHI
```

## QRP1 parity frame

```text
4s  magic = "QRP1"
8s  file_id
H   group_start        # 0-based data-frame index
H   total_data_frames
B   group_count
B   parity_index
H   payload_len
I   crc32
... payload
```

Python struct：

```text
>4s8sHHBBHI
```

视频模式中的 data block 在发送端补零到固定 `chunk_size`，使 parity block 与 data block 等长。

## FEC

有限域为 GF(256)，生成多项式 `0x11D`。

第 `p` 个 parity 对 group 内第 `pos` 个 data block 的系数为：

```text
coef = (pos + 1) ^ p    # GF(256) exponentiation
```

因此 `p=0` 是所有数据块的 XOR；后续 parity 构成 Vandermonde 方程组。只要同一组缺失 data block 数量不超过已收到 parity block 数量，就可以通过 GF(256) 矩阵求逆恢复。

## QRFS1 file stream

所有 QRF1 payload 按 index 拼接后得到 stream（视频模式末尾可能带零 padding）。

```text
5s  magic = "QRFS1"
B   flags               # bit0 = zlib
Q   original_size
Q   packed_size
32s sha256(original_file)
H   utf8_filename_len
... utf8 filename
... packed/raw file data
... optional zero padding
```

Python struct：

```text
>5sBQQ32sH
```

接收端恢复时：

1. 根据 `packed_size` 截取 payload。
2. `flags & 1` 时执行 zlib 解压。
3. 校验 `original_size`。
4. 对原始数据计算 SHA-256 并与 header 比较。
5. 仅在全部校验成功后向用户提供恢复文件。
