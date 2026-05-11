import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { Cart } from './entities/cart.entity';
import { CartItem } from './entities/cart-item.entity';
import { Product, ProductStatus } from '../products/entities/product.entity';
import { AddToCartDto } from './dto/add-to-cart.dto';
import { UpdateCartItemDto } from './dto/update-cart-item.dto';
import { getPrimaryMediaUrl } from '../products/utils/product-media.util';

@Injectable()
export class CartService {
  constructor(
    @InjectRepository(Cart)
    private cartRepository: Repository<Cart>,
    @InjectRepository(CartItem)
    private cartItemRepository: Repository<CartItem>,
    @InjectRepository(Product)
    private productRepository: Repository<Product>,
  ) {}

  async getCart(userId: number) {
    let cart = await this.cartRepository
      .createQueryBuilder('cart')
      .leftJoinAndSelect('cart.items', 'items')
      .leftJoinAndSelect('items.product', 'product')
      .leftJoinAndSelect('product.productMedia', 'productMedia')
      .leftJoinAndSelect('productMedia.media', 'media')
      .where('cart.user_id = :userId', { userId })
      .orderBy('items.id', 'ASC')
      .getOne();

    if (!cart) {
      cart = this.cartRepository.create({
        user_id: userId,
        items: [],
      });
      await this.cartRepository.save(cart);
    }

    // Calculate totals or format structure if needed
    return await this.formatCartResponse(cart);
  }

  async addToCart(userId: number, dto: AddToCartDto) {
    const { product_id, variant_id, quantity = 1 } = dto;

    // Validate product
    const product = await this.productRepository.findOne({
      where: { id: product_id },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    if (product.status === ProductStatus.ARCHIVED) {
      throw new BadRequestException('Cannot add archived product to cart');
    }

    // Get user cart
    let cart = await this.cartRepository.findOne({
      where: { user_id: userId },
      relations: ['items'],
    });

    if (!cart) {
      cart = this.cartRepository.create({
        user_id: userId,
        items: [],
      });
      await this.cartRepository.save(cart);
    }

    // Check if item exists
    const existingItem = await this.cartItemRepository.findOne({
      where: {
        cart_id: cart.id,
        product_id: product_id,
        variant_id: variant_id || IsNull(),
      },
    });

    if (existingItem) {
      existingItem.quantity += quantity;
      await this.cartItemRepository.save(existingItem);
    } else {
      const newItem = this.cartItemRepository.create({
        cart_id: cart.id,
        product_id: product_id,
        variant_id: variant_id,
        quantity: quantity,
      });
      await this.cartItemRepository.save(newItem);
    }

    return this.getCart(userId);
  }

  async updateItem(userId: number, itemId: number, dto: UpdateCartItemDto) {
    const item = await this.cartItemRepository.findOne({
      where: { id: itemId },
      relations: ['cart'],
    });

    if (!item || item.cart.user_id !== userId) {
      throw new NotFoundException('Cart item not found');
    }

    if (item.quantity !== dto.quantity) {
      item.quantity = dto.quantity;
      await this.cartItemRepository.save(item);
    }

    return this.getCart(userId);
  }

  async removeItem(userId: number, itemId: number) {
    const item = await this.cartItemRepository.findOne({
      where: { id: itemId },
      relations: ['cart'],
    });

    if (!item || item.cart.user_id !== userId) {
      throw new NotFoundException('Cart item not found');
    }

    await this.cartItemRepository.remove(item);

    return this.getCart(userId);
  }

  async clearCart(userId: number) {
    const cart = await this.cartRepository.findOne({
      where: { user_id: userId },
      relations: ['items'],
    });

    if (cart && cart.items.length > 0) {
      await this.cartItemRepository.remove(cart.items);
    }

    return this.getCart(userId);
  }

  private async formatCartResponse(cart: Cart) {
    const items = cart.items.map((item) => {
      const image = getPrimaryMediaUrl(item.product);

      const regularPrice = item.product ? Number(item.product.price) : 0;
      const salePrice =
        item.product?.sale_price != null
          ? Number(item.product.sale_price)
          : null;

      return {
        id: item.id,
        product_id: item.product_id,
        variant_id: item.variant_id,
        quantity: item.quantity,
        product: {
          id: item.product.id,
          name_en: item.product.name_en,
          name_ar: item.product.name_ar,
          price: regularPrice,
          sale_price: salePrice,
          image: image,
        },
        variant: null,
      };
    });

    // Calculate total amount
    const totalAmount = items.reduce((sum, item) => {
      // price is now the regular price, we need to check if there is a sale price
      const price =
        item.product.sale_price !== null
          ? Number(item.product.sale_price)
          : Number(item.product.price);
      return sum + price * item.quantity;
    }, 0);

    return {
      id: cart.id,
      user_id: cart.user_id,
      items,
      total_amount: totalAmount,
    };
  }
}
