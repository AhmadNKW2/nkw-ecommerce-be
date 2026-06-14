import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Patch,
  Delete,
  UseGuards,
  Query,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { FilterUserDto } from './dto/filter-user.dto';
import { Roles, UserRole } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import {
  ApiErrorResponseDto,
  ApiWrappedResponse,
} from '../common/swagger/api-response.dto';
import {
  UserDetailResponseDto,
  UserResponseDto,
  UserSummaryResponseDto,
} from './dto/user-response.dto';

@ApiTags('Users')
@ApiBearerAuth('bearer')
@ApiCookieAuth('cookieAuth')
@ApiUnauthorizedResponse({
  description: 'Authentication is required.',
  type: ApiErrorResponseDto,
})
@ApiForbiddenResponse({
  description: 'The current user does not have access to this operation.',
  type: ApiErrorResponseDto,
})
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // Create user (Admin only) - Can specify role during creation
  @Post()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Create a user' })
  @ApiBody({
    type: CreateUserDto,
    examples: {
      regular_user: {
        summary: 'Regular user',
        value: {
          email: 'aisha@example.com',
          firstName: 'Aisha',
          lastName: 'Khalid',
          password: 'StrongPass123',
          phone: '+966500000000',
          role: UserRole.USER,
          product_ids: [101, 205],
        },
      },
      catalog_manager: {
        summary: 'Catalog manager',
        value: {
          email: 'catalog@example.com',
          firstName: 'Maha',
          lastName: 'Salem',
          password: 'StrongPass123',
          role: UserRole.CATALOG_MANAGER,
          image: 'https://cdn.example.com/users/catalog-manager.jpg',
        },
      },
    },
  })
  @ApiWrappedResponse({
    status: 201,
    description: 'User created successfully.',
    model: UserResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Validation error.',
    type: ApiErrorResponseDto,
  })
  @ApiConflictResponse({
    description: 'Email already exists.',
    type: ApiErrorResponseDto,
  })
  async create(@Body() createUserDto: CreateUserDto) {
    const user = await this.usersService.create(createUserDto);
    return this.usersService.sanitizeUser(user);
  }

  // Get all users with filtering (Admin & Catalog Manager)
  @Get()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.CATALOG_MANAGER)
  @ApiOperation({ summary: 'List users' })
  @ApiWrappedResponse({
    status: 200,
    description: 'Users returned successfully.',
    model: UserSummaryResponseDto,
    isArray: true,
    paginated: true,
  })
  @ApiBadRequestResponse({
    description: 'Invalid query parameters.',
    type: ApiErrorResponseDto,
  })
  findAll(@Query() filterDto: FilterUserDto) {
    return this.usersService.findAll(filterDto);
  }

  // Get one user (Admin only)
  @Get(':id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Get a user by id' })
  @ApiParam({ name: 'id', example: 42 })
  @ApiWrappedResponse({
    status: 200,
    description: 'User returned successfully.',
    model: UserDetailResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'User not found.',
    type: ApiErrorResponseDto,
  })
  findOne(@Param('id') id: number) {
    return this.usersService.findOne(id);
  }

  // Update user (Admin only) - Can update role here
  @Patch(':id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Update a user' })
  @ApiParam({ name: 'id', example: 42 })
  @ApiBody({
    type: UpdateUserDto,
    examples: {
      activate_user: {
        summary: 'Activate and promote a user',
        value: {
          role: UserRole.CATALOG_MANAGER,
          isActive: true,
          phone: '+966511111111',
        },
      },
      sync_wishlist: {
        summary: 'Sync wishlist and profile image',
        value: {
          image: 'https://cdn.example.com/users/42/profile-v2.jpg',
          product_ids: [310, 311, 312],
        },
      },
    },
  })
  @ApiWrappedResponse({
    status: 200,
    description: 'User updated successfully.',
    model: UserResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Validation error.',
    type: ApiErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'User not found.',
    type: ApiErrorResponseDto,
  })
  async update(@Param('id') id: number, @Body() updateUserDto: UpdateUserDto) {
    const user = await this.usersService.update(id, updateUserDto);
    return this.usersService.sanitizeUser(user);
  }

  // Delete user (Admin only)
  @Delete(':id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Delete a user' })
  @ApiParam({ name: 'id', example: 42 })
  @ApiWrappedResponse({
    status: 200,
    description: 'User deleted successfully.',
  })
  @ApiNotFoundResponse({
    description: 'User not found.',
    type: ApiErrorResponseDto,
  })
  remove(@Param('id') id: number) {
    return this.usersService.remove(id);
  }
}
