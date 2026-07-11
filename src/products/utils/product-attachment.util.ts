import { Media } from '../../media/entities/media.entity';
import { ProductAttachment } from '../entities/product-attachment.entity';

export type ProductAttachmentView = Media & {
  sort_order: number;
};

type ProductAttachmentContainer = {
  productAttachments?: ProductAttachment[] | null;
  attachments?: ProductAttachmentView[];
};

export function hydrateProductAttachments<T extends ProductAttachmentContainer>(
  product: T | null | undefined,
  stripRelation = false,
): T | null | undefined {
  if (!product) {
    return product;
  }

  const attachments = (product.productAttachments ?? [])
    .filter(
      (link): link is ProductAttachment & { media: Media } =>
        Boolean(link?.media),
    )
    .sort((left, right) => {
      if (left.sort_order !== right.sort_order) {
        return left.sort_order - right.sort_order;
      }

      return left.media.id - right.media.id;
    })
    .map((link) => ({
      ...link.media,
      sort_order: link.sort_order,
    }));

  product.attachments = attachments;

  if (stripRelation) {
    delete (product as any).productAttachments;
  }

  return product;
}

export function hydrateProductsAttachments<T extends ProductAttachmentContainer>(
  products: T[],
  stripRelation = false,
): T[] {
  products.forEach((product) => {
    hydrateProductAttachments(product, stripRelation);
  });

  return products;
}
